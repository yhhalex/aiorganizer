export const runtime = "nodejs";

const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_EMBEDDING_DIMENSIONS = 1536;
const MAX_BATCH_SIZE = 96;

function cleanInput(input) {
  const values = Array.isArray(input) ? input : [input];
  return values.map((value) => String(value || "").trim()).filter(Boolean);
}

export async function POST(request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return Response.json(
        { error: "OPENAI_API_KEY is required to create embeddings." },
        { status: 500 }
      );
    }

    const body = await request.json();
    const input = cleanInput(body.input);
    if (!input.length) {
      return Response.json({ error: "Embedding input is required." }, { status: 400 });
    }

    if (input.length > MAX_BATCH_SIZE) {
      return Response.json({ error: `Embed at most ${MAX_BATCH_SIZE} chunks per request.` }, { status: 400 });
    }

    const model = body.model || DEFAULT_EMBEDDING_MODEL;
    const dimensions = body.dimensions || DEFAULT_EMBEDDING_DIMENSIONS;
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        input,
        dimensions,
        encoding_format: "float"
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return Response.json(
        { error: payload.error?.message || "OpenAI embedding request failed." },
        { status: response.status }
      );
    }

    return Response.json({
      ok: true,
      model: payload.model || model,
      dimensions,
      usage: payload.usage || null,
      embeddings: payload.data
        .sort((left, right) => left.index - right.index)
        .map((entry) => entry.embedding)
    });
  } catch (error) {
    return Response.json({ error: error.message || "Embedding request failed." }, { status: 500 });
  }
}
