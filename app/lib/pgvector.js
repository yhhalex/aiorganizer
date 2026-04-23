import pg from "pg";

const { Pool } = pg;

let pool;

export function isPgvectorConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

export function getPgPool() {
  if (!isPgvectorConfigured()) {
    throw new Error("DATABASE_URL is not configured.");
  }

  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5
    });
  }

  return pool;
}

export function vectorLiteral(embedding) {
  if (!Array.isArray(embedding) || !embedding.length) {
    return null;
  }

  const values = embedding.map((value) => {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      throw new Error("Embedding contains a non-numeric value.");
    }
    return number;
  });

  return `[${values.join(",")}]`;
}

export async function withPgClient(callback) {
  const client = await getPgPool().connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

export async function upsertSource(client, source) {
  if (!source?.source_id && !source?.id) return;

  await client.query(
    `
      INSERT INTO sources (id, source_type, title, raw_text, metadata, parser, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, COALESCE($7::timestamptz, now()), COALESCE($8::timestamptz, now()))
      ON CONFLICT (id) DO UPDATE SET
        source_type = EXCLUDED.source_type,
        title = EXCLUDED.title,
        raw_text = EXCLUDED.raw_text,
        metadata = EXCLUDED.metadata,
        parser = EXCLUDED.parser,
        updated_at = EXCLUDED.updated_at
    `,
    [
      source.source_id || source.id,
      source.source_type || source.parser_source_type || source.type || "unknown",
      source.title || "Untitled",
      source.raw_text || source.content_text || "",
      JSON.stringify(source.metadata || {}),
      source.parser || "unknown",
      source.created_at || null,
      source.updated_at || null
    ]
  );
}

export async function upsertFolder(client, folder) {
  if (!folder?.id) return;

  await client.query(
    `
      INSERT INTO folders (id, name, description, metadata, created_at, updated_at)
      VALUES ($1, $2, $3, $4::jsonb, COALESCE($5::timestamptz, now()), COALESCE($6::timestamptz, now()))
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        metadata = EXCLUDED.metadata,
        updated_at = EXCLUDED.updated_at
    `,
    [
      folder.id,
      folder.name || "Untitled folder",
      folder.description || "",
      JSON.stringify(folder.metadata || {}),
      folder.created_at || null,
      folder.updated_at || null
    ]
  );
}

export async function upsertFolderItem(client, folderItem) {
  if (!folderItem?.id || !folderItem.folder_id || !folderItem.source_id) return;

  await client.query(
    `
      INSERT INTO folder_items (id, folder_id, source_id, assignment_type, created_at)
      VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()))
      ON CONFLICT (id) DO UPDATE SET
        folder_id = EXCLUDED.folder_id,
        source_id = EXCLUDED.source_id,
        assignment_type = EXCLUDED.assignment_type
    `,
    [
      folderItem.id,
      folderItem.folder_id,
      folderItem.source_id,
      folderItem.assignment_type || "manual",
      folderItem.created_at || null
    ]
  );
}

export async function upsertDocumentChunk(client, chunk) {
  if (!chunk?.id || !chunk.source_id) return;

  const embedding = vectorLiteral(chunk.embedding);

  await client.query(
    `
      INSERT INTO document_chunks (
        id, source_id, item_id, chunk_index, heading, markdown, text, char_count, metadata,
        embedding, embedding_model, embedding_dimensions, embedding_status, embedded_at, created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
        $10::vector, $11, $12, $13, $14::timestamptz, COALESCE($15::timestamptz, now()), COALESCE($16::timestamptz, now())
      )
      ON CONFLICT (id) DO UPDATE SET
        source_id = EXCLUDED.source_id,
        item_id = EXCLUDED.item_id,
        chunk_index = EXCLUDED.chunk_index,
        heading = EXCLUDED.heading,
        markdown = EXCLUDED.markdown,
        text = EXCLUDED.text,
        char_count = EXCLUDED.char_count,
        metadata = EXCLUDED.metadata,
        embedding = COALESCE(EXCLUDED.embedding, document_chunks.embedding),
        embedding_model = COALESCE(EXCLUDED.embedding_model, document_chunks.embedding_model),
        embedding_dimensions = COALESCE(EXCLUDED.embedding_dimensions, document_chunks.embedding_dimensions),
        embedding_status = EXCLUDED.embedding_status,
        embedded_at = COALESCE(EXCLUDED.embedded_at, document_chunks.embedded_at),
        updated_at = EXCLUDED.updated_at
    `,
    [
      chunk.id,
      chunk.source_id,
      chunk.item_id || chunk.source_id,
      chunk.chunk_index || 0,
      chunk.heading || "Document",
      chunk.markdown || "",
      chunk.text || "",
      chunk.char_count || (chunk.text || "").length,
      JSON.stringify(chunk.metadata || {}),
      embedding,
      chunk.embedding_model || null,
      chunk.embedding_dimensions || null,
      chunk.embedding_status || (embedding ? "embedded" : "pending"),
      chunk.embedded_at || null,
      chunk.created_at || null,
      chunk.updated_at || null
    ]
  );
}

export async function upsertFolderProfile(client, profile) {
  if (!profile?.id || !profile.folder_id) return;

  const embedding = vectorLiteral(profile.embedding);

  await client.query(
    `
      INSERT INTO folder_profiles (
        id, folder_id, profile_text, metadata, embedding, embedding_model, embedding_dimensions, created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4::jsonb, $5::vector, $6, $7, COALESCE($8::timestamptz, now()), COALESCE($9::timestamptz, now())
      )
      ON CONFLICT (id) DO UPDATE SET
        folder_id = EXCLUDED.folder_id,
        profile_text = EXCLUDED.profile_text,
        metadata = EXCLUDED.metadata,
        embedding = COALESCE(EXCLUDED.embedding, folder_profiles.embedding),
        embedding_model = COALESCE(EXCLUDED.embedding_model, folder_profiles.embedding_model),
        embedding_dimensions = COALESCE(EXCLUDED.embedding_dimensions, folder_profiles.embedding_dimensions),
        updated_at = EXCLUDED.updated_at
    `,
    [
      profile.id,
      profile.folder_id,
      profile.profile_text || "",
      JSON.stringify(profile.metadata || {}),
      embedding,
      profile.embedding_model || null,
      profile.embedding_dimensions || null,
      profile.created_at || null,
      profile.updated_at || null
    ]
  );
}

export async function searchDocumentChunks(embedding, limit = 5) {
  const vector = vectorLiteral(embedding);
  if (!vector) {
    throw new Error("Query embedding is required.");
  }

  return withPgClient(async (client) => {
    const result = await client.query(
      `
        WITH base AS (
          SELECT
            c.id,
            c.source_id,
            c.item_id,
            c.chunk_index,
            c.heading,
            c.text,
            c.markdown,
            c.embedding_model,
            c.embedding_dimensions,
            s.title AS source_title,
            s.source_type,
            COALESCE(string_agg(DISTINCT f.name, ', ' ORDER BY f.name), 'Unfiled') AS folder_name,
            (c.embedding <=> $1::vector) AS distance
          FROM document_chunks c
          JOIN sources s ON s.id = c.source_id
          LEFT JOIN folder_items fi ON fi.source_id = s.id
          LEFT JOIN folders f ON f.id = fi.folder_id
          WHERE c.embedding IS NOT NULL
          GROUP BY
            c.id,
            c.source_id,
            c.item_id,
            c.chunk_index,
            c.heading,
            c.text,
            c.markdown,
            c.embedding_model,
            c.embedding_dimensions,
            c.embedding,
            s.title,
            s.source_type
        ),
        ranked AS (
          SELECT
            *,
            row_number() OVER (PARTITION BY item_id ORDER BY distance ASC) AS rn
          FROM base
        )
        SELECT
          id,
          source_id,
          item_id,
          chunk_index,
          heading,
          text,
          markdown,
          embedding_model,
          embedding_dimensions,
          source_title,
          source_type,
          folder_name,
          1 - distance AS score
        FROM ranked
        WHERE rn = 1
        ORDER BY distance ASC
        LIMIT $2
      `,
      [vector, Math.max(1, Math.min(Number(limit) || 5, 20))]
    );

    return result.rows;
  });
}
