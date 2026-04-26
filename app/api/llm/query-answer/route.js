export const runtime = "nodejs";

const DEFAULT_MODEL = "gpt-4o-mini";

const answerSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "cited_item_ids"],
  properties: {
    answer: {
      type: "string",
      description: "Concise answer grounded only in the provided file contexts."
    },
    cited_item_ids: {
      type: "array",
      description: "Subset of provided item_ids that directly support the answer.",
      items: {
        type: "string"
      },
      maxItems: 5
    }
  }
};

function extractRefusal(payload) {
  for (const output of payload?.output || []) {
    if (output?.type !== "message") continue;
    for (const item of output?.content || []) {
      if (item?.type === "refusal" && item.refusal) {
        return String(item.refusal);
      }
    }
  }
  return "";
}

function extractStructuredOutput(payload) {
  if (payload?.output_text) {
    return { kind: "text", value: String(payload.output_text).trim() };
  }

  let text = "";
  for (const output of payload?.output || []) {
    if (output?.type !== "message") continue;
    for (const item of output?.content || []) {
      if (item?.parsed && typeof item.parsed === "object") {
        return { kind: "json", value: item.parsed };
      }

      if (typeof item?.text === "string") {
        text += item.text;
      }
    }
  }

  return { kind: "text", value: text.trim() };
}

function sanitizeSource(source) {
  return {
    item_id: String(source?.item_id || ""),
    title: String(source?.title || ""),
    source_type: String(source?.source_type || ""),
    folder_name: String(source?.folder_name || ""),
    score: Number(source?.score || 0),
    chunks: Array.isArray(source?.chunks)
      ? source.chunks.slice(0, 3).map((chunk) => ({
        chunk_index: Number(chunk?.chunk_index || 0),
        heading: String(chunk?.heading || ""),
        text: String(chunk?.text || ""),
        score: Number(chunk?.score || 0)
      })).filter((chunk) => chunk.text)
      : []
  };
}

export async function POST(request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return Response.json(
        { ok: false, error: "OPENAI_API_KEY is required for query answering." },
        { status: 500 }
      );
    }

    const body = await request.json();
    const question = String(body.question || "").trim();
    const sources = (body.sources || [])
      .map(sanitizeSource)
      .filter((source) => source.item_id && source.chunks.length);
    const model = body.model || DEFAULT_MODEL;

    if (!question) {
      return Response.json({ ok: false, error: "Question is required." }, { status: 400 });
    }

    if (!sources.length) {
      return Response.json({ ok: false, error: "At least one retrieved file is required." }, { status: 400 });
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: [
                  "Answer the user's question using only the provided file contexts.",
                  "Do not invent facts beyond those contexts.",
                  "If the contexts are insufficient, say that clearly.",
                  "Keep the answer concise and directly useful.",
                  "Only include cited_item_ids that appear in the provided sources."
                ].join(" ")
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify({
                  question,
                  sources
                })
              }
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "query_answer",
            strict: true,
            schema: answerSchema
          }
        }
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return Response.json(
        { ok: false, error: payload.error?.message || "OpenAI query answer request failed." },
        { status: response.status }
      );
    }

    const refusal = extractRefusal(payload);
    if (refusal) {
      return Response.json(
        { ok: false, error: `Query answer model refused: ${refusal}` },
        { status: 422 }
      );
    }

    const extracted = extractStructuredOutput(payload);
    let answerPayload;
    if (extracted.kind === "json") {
      answerPayload = extracted.value;
    } else {
      try {
        answerPayload = JSON.parse(extracted.value);
      } catch (error) {
        return Response.json(
          { ok: false, error: "Query answer output was not valid JSON." },
          { status: 502 }
        );
      }
    }

    const validItemIds = new Set(sources.map((source) => source.item_id));
    const answer = String(answerPayload?.answer || "").trim();
    const citedItemIds = Array.isArray(answerPayload?.cited_item_ids)
      ? answerPayload.cited_item_ids
        .map((value) => String(value || ""))
        .filter((value) => validItemIds.has(value))
        .slice(0, 5)
      : [];

    if (!answer) {
      return Response.json(
        { ok: false, error: "Query answer output was empty." },
        { status: 502 }
      );
    }

    return Response.json({
      ok: true,
      model: payload.model || model,
      answer,
      cited_item_ids: citedItemIds
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error.message || "LLM query answering failed." },
      { status: 500 }
    );
  }
}
