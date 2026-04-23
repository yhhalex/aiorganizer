import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const runtime = "nodejs";

const SUPPORTED_EXTENSIONS = new Set([".pdf", ".docx", ".pptx", ".md", ".markdown"]);
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function safeFileName(name) {
  const extension = path.extname(name).toLowerCase();
  const baseName = path.basename(name, extension).replace(/[^a-z0-9._-]+/gi, "-").slice(0, 80) || "upload";
  return `${baseName}${extension}`;
}

function pythonCandidates() {
  const bundledPython = path.join(
    homedir(),
    ".cache",
    "codex-runtimes",
    "codex-primary-runtime",
    "dependencies",
    "python",
    "bin",
    "python3"
  );

  return [
    process.env.DOCLING_PYTHON,
    process.env.PYTHON,
    existsSync(bundledPython) ? bundledPython : "",
    "python3",
    "python"
  ].filter(Boolean);
}

function runDoclingParser(filePath) {
  const scriptPath = path.join(process.cwd(), "scripts", "docling_parser.py");

  return new Promise((resolve, reject) => {
    const [python, ...fallbacks] = pythonCandidates();
    let stderr = "";
    let stdout = "";

    function start(command, remainingCommands) {
      const child = spawn(command, [scriptPath, filePath], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        if (remainingCommands.length) {
          start(remainingCommands[0], remainingCommands.slice(1));
          return;
        }

        reject(error);
      });

      child.on("close", (code) => {
        if (code !== 0) {
          let parsedError = null;
          try {
            parsedError = JSON.parse(stdout.trim());
          } catch {
            parsedError = null;
          }

          reject(new Error(parsedError?.error || stderr.trim() || "Docling parsing failed."));
          return;
        }

        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (error) {
          reject(new Error(`Docling returned invalid JSON: ${error.message}`));
        }
      });
    }

    start(python, fallbacks);
  });
}

export async function POST(request) {
  let uploadDir = "";

  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!file || typeof file.arrayBuffer !== "function") {
      return Response.json({ error: "Upload a file to parse." }, { status: 400 });
    }

    const extension = path.extname(file.name || "").toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      return Response.json(
        { error: "Supported parsing formats are PDF, DOCX, PPTX, and Markdown." },
        { status: 400 }
      );
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      return Response.json({ error: "Files must be 25 MB or smaller for local parsing." }, { status: 413 });
    }

    uploadDir = path.join(tmpdir(), `ai-organizer-${crypto.randomUUID()}`);
    await mkdir(uploadDir, { recursive: true });

    const filePath = path.join(uploadDir, safeFileName(file.name || `upload${extension}`));
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(filePath, buffer);

    const result = await runDoclingParser(filePath);
    if (!result.ok) {
      return Response.json({ error: result.error || "Docling parsing failed." }, { status: 422 });
    }

    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error.message || "File could not be parsed." }, { status: 500 });
  } finally {
    if (uploadDir) {
      await rm(uploadDir, { recursive: true, force: true });
    }
  }
}
