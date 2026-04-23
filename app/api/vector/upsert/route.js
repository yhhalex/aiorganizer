import {
  isPgvectorConfigured,
  upsertDocumentChunk,
  upsertFolder,
  upsertFolderItem,
  upsertFolderProfile,
  upsertSource,
  withPgClient
} from "../../../lib/pgvector";

export const runtime = "nodejs";

export async function POST(request) {
  if (!isPgvectorConfigured()) {
    return Response.json(
      { ok: false, configured: false, error: "DATABASE_URL is required for pgvector sync." },
      { status: 503 }
    );
  }

  try {
    const body = await request.json();
    const sources = [...(body.sources || []), ...(body.source ? [body.source] : [])];
    const folders = body.folders || [];
    const folderItems = body.folderItems || [];
    const chunks = body.chunks || [];
    const folderProfiles = body.folderProfiles || [];
    const deleteFolderItemIds = body.deleteFolderItemIds || [];

    await withPgClient(async (client) => {
      await client.query("BEGIN");
      try {
        for (const id of deleteFolderItemIds) {
          await client.query("DELETE FROM folder_items WHERE id = $1", [id]);
        }
        for (const source of sources) {
          await upsertSource(client, source);
        }
        for (const folder of folders) {
          await upsertFolder(client, folder);
        }
        for (const folderItem of folderItems) {
          await upsertFolderItem(client, folderItem);
        }
        for (const chunk of chunks) {
          await upsertDocumentChunk(client, chunk);
        }
        for (const folderProfile of folderProfiles) {
          await upsertFolderProfile(client, folderProfile);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });

    return Response.json({
      ok: true,
      configured: true,
      counts: {
        sources: sources.length,
        folders: folders.length,
        folderItems: folderItems.length,
        chunks: chunks.length,
        folderProfiles: folderProfiles.length,
        deletedFolderItems: deleteFolderItemIds.length
      }
    });
  } catch (error) {
    return Response.json(
      { ok: false, configured: true, error: error.message || "pgvector sync failed." },
      { status: 500 }
    );
  }
}
