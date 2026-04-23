export const runtime = "nodejs";
const DEFAULT_MODEL = "gpt-4o-mini";

// DEBUG: server-side logging for LLM folder decisioning.
const DEBUG_LLM_FOLDER_LOGS = false;

function debugFolderDecision(...args) {
  if (!DEBUG_LLM_FOLDER_LOGS) return;
  // eslint-disable-next-line no-console
  console.debug("[ai-organizer][folder-decision]", ...args);
}

const decisionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "action",
    "folder_id",
    "new_folder_name",
    "new_folder_description",
    "confidence",
    "reason"
  ],
  properties: {
    action: {
      type: "string",
      enum: ["assign_existing", "create_folder"]
    },
    folder_id: {
      type: "string",
      description: "Existing folder id when action is assign_existing; otherwise empty string."
    },
    new_folder_name: {
      type: "string",
      description: "Short generic folder name (broad topic) when action is create_folder; otherwise empty string."
    },
    new_folder_description: {
      type: "string",
      description: "One sentence folder description when action is create_folder; otherwise empty string."
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1
    },
    reason: {
      type: "string",
      description: "Concise explanation for the folder decision."
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
  // Fast path used by some Responses SDKs.
  if (payload?.output_text) {
    return { kind: "text", value: String(payload.output_text).trim() };
  }

  let text = "";
  for (const output of payload?.output || []) {
    if (output?.type !== "message") continue;
    for (const item of output?.content || []) {
      // Some structured output helpers attach a parsed object.
      if (item?.parsed && typeof item.parsed === "object") {
        return { kind: "json", value: item.parsed };
      }

      // Fallback: concatenate any plain text fields.
      if (typeof item?.text === "string") {
        text += item.text;
      }
    }
  }

  return { kind: "text", value: text.trim() };
}

function sanitizeCandidate(candidate) {
  return {
    folder_id: String(candidate.folder_id || ""),
    name: String(candidate.name || ""),
    description: String(candidate.description || ""),
    similarity_score: Number(candidate.similarity_score || 0),
    profile_text: String(candidate.profile_text || "")
  };
}

export async function POST(request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return Response.json(
        { ok: false, error: "OPENAI_API_KEY is required for LLM folder decisioning." },
        { status: 500 }
      );
    }

    const body = await request.json();
    const item = body.item || {};
    const candidates = (body.candidates || []).map(sanitizeCandidate);
    const threshold = Number(body.threshold || 0.6);
    const model = body.model || DEFAULT_MODEL;

    debugFolderDecision("request", {
      model,
      threshold,
      candidate_count: candidates.length,
      title: String(item.title || ""),
      source_type: String(item.source_type || "")
    });

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
                  "You decide document folder placement after embedding similarity produced zero matches above the threshold.",
                  "Use existing folders only when the document clearly belongs there.",
                  "Prefer assign_existing whenever any candidate folder is a reasonable fit, even if similarity_score is below the threshold.",
                  "Only create_folder when none of the candidate_folders fit at all.",
                  "When action is assign_existing, folder_id must be one of the candidate_folders[].folder_id values.",
                  "If you create_folder, choose the most generic parent topic that would reasonably contain the document.",
                  "Folder names must be concise (usually 1-3 words), human-readable, and not based on file names alone.",
                  "Avoid overly-specific suffixes like Techniques, Methods, Optimization, Gradient Descent, Lecture, Slides, Notes, or Week numbers.",
                  "Return only the structured JSON schema."
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
                  threshold,
                  document: {
                    source_id: item.source_id || "",
                    title: item.title || "",
                    source_type: item.source_type || "",
                    raw_text: String(item.raw_text || "").slice(0, 4000),
                    chunks: item.chunks || []
                  },
                  candidate_folders: candidates
                })
              }
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "folder_decision",
            strict: true,
            schema: decisionSchema
          }
        }
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return Response.json(
        { ok: false, error: payload.error?.message || "OpenAI folder decision request failed." },
        { status: response.status }
      );
    }

    const refusal = extractRefusal(payload);
    if (refusal) {
      debugFolderDecision("refusal", { refusal });
      return Response.json(
        { ok: false, error: `Folder decision model refused: ${refusal}` },
        { status: 422 }
      );
    }

    const extracted = extractStructuredOutput(payload);
    let decision;
    if (extracted.kind === "json") {
      decision = extracted.value;
    } else {
      try {
        decision = JSON.parse(extracted.value);
      } catch (error) {
        const preview = extracted.value ? extracted.value.slice(0, 240) : "";
        debugFolderDecision("parse_error", { message: error.message, preview });
        return Response.json(
          {
            ok: false,
            error: "Folder decision output was not valid JSON.",
            details: {
              parse_error: error.message,
              output_preview: preview
            }
          },
          { status: 502 }
        );
      }
    }

    debugFolderDecision("response", {
      action: decision?.action,
      folder_id: decision?.folder_id,
      new_folder_name: decision?.new_folder_name,
      confidence: decision?.confidence
    });

    return Response.json({
      ok: true,
      model: payload.model || model,
      decision
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error.message || "LLM folder decision failed." },
      { status: 500 }
    );
  }
}
