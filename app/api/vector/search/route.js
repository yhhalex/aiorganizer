import { isPgvectorConfigured, searchDocumentChunks } from "../../../lib/pgvector";

export const runtime = "nodejs";

export async function POST(request) {
  if (!isPgvectorConfigured()) {
    return Response.json(
      { ok: false, configured: false, error: "DATABASE_URL is required for pgvector search." },
      { status: 503 }
    );
  }

  try {
    const body = await request.json();
    const results = await searchDocumentChunks(body.embedding, body.limit || 5);

    return Response.json({
      ok: true,
      configured: true,
      results
    });
  } catch (error) {
    return Response.json(
      { ok: false, configured: true, error: error.message || "pgvector search failed." },
      { status: 500 }
    );
  }
}
