import { readFileSync } from "node:fs";
import { Client } from "pg";

function loadEnvFile(path, { override = false } = {}) {
  try {
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line || line.trim().startsWith("#")) continue;
      const [name, ...valueParts] = line.split("=");
      if (name && valueParts.length && (override || !process.env[name])) {
        process.env[name] = valueParts.join("=").trim();
      }
    }
  } catch {
    // DATABASE_URL can also be provided by the shell.
  }
}

async function main() {
  loadEnvFile(".env");
  loadEnvFile(".env.local", { override: true });

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required. See .env.example for the local pgvector URL.");
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const sql = readFileSync("db/migrations/001_pgvector.sql", "utf8");
    await client.query(sql);
    console.log("pgvector schema is ready.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  const detail = [error.message, error.code, error.address, error.port]
    .filter(Boolean)
    .join(" ");
  console.error(`pgvector setup failed: ${detail || "unknown database connection error"}`);
  process.exit(1);
});
