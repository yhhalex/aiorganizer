#!/usr/bin/env python3
"""Parse supported documents with Docling and emit JSON for the web app."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

SUPPORTED_EXTENSIONS = {
    ".pdf": "pdf",
    ".docx": "docx",
    ".pptx": "pptx",
    ".md": "markdown",
    ".markdown": "markdown",
}


def normalize_text(value: str) -> str:
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def markdown_to_plain_text(markdown: str) -> str:
    text = re.sub(r"```.*?```", " ", markdown, flags=re.S)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"!\[[^\]]*\]\([^)]+\)", " ", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"^\s{0,3}#{1,6}\s*", "", text, flags=re.M)
    text = re.sub(r"^\s{0,3}[-*+]\s+", "", text, flags=re.M)
    text = re.sub(r"[*_~>#|]", " ", text)
    text = re.sub(r"[ \t]+", " ", text)
    return normalize_text(text)


def split_by_headings(markdown: str) -> list[tuple[str, str]]:
    sections: list[tuple[str, list[str]]] = []
    current_heading = "Document"
    current_lines: list[str] = []

    for line in markdown.splitlines():
        match = re.match(r"^\s{0,3}(#{1,6})\s+(.+?)\s*$", line)
        if match:
            if current_lines:
                sections.append((current_heading, current_lines))
            current_heading = match.group(2).strip()
            current_lines = [line]
        else:
            current_lines.append(line)

    if current_lines:
        sections.append((current_heading, current_lines))

    return [(heading, normalize_text("\n".join(lines))) for heading, lines in sections if normalize_text("\n".join(lines))]


def split_long_text(text: str, max_chars: int) -> list[str]:
    if len(text) <= max_chars:
        return [text]

    paragraphs = [paragraph.strip() for paragraph in re.split(r"\n\s*\n", text) if paragraph.strip()]
    chunks: list[str] = []
    current = ""

    for paragraph in paragraphs:
        if len(paragraph) > max_chars:
            if current:
                chunks.append(current.strip())
                current = ""
            sentences = re.split(r"(?<=[.!?])\s+", paragraph)
            for sentence in sentences:
                if not sentence:
                    continue
                if len(current) + len(sentence) + 1 > max_chars and current:
                    chunks.append(current.strip())
                    current = sentence
                else:
                    current = f"{current} {sentence}".strip()
            continue

        if len(current) + len(paragraph) + 2 > max_chars and current:
            chunks.append(current.strip())
            current = paragraph
        else:
            current = f"{current}\n\n{paragraph}".strip()

    if current:
        chunks.append(current.strip())

    return chunks


def chunk_markdown(markdown: str, max_chars: int) -> list[dict[str, object]]:
    chunks: list[dict[str, object]] = []

    for heading, section_text in split_by_headings(markdown):
        for part in split_long_text(section_text, max_chars):
            plain_text = markdown_to_plain_text(part)
            if not plain_text:
                continue
            chunks.append(
                {
                    "index": len(chunks),
                    "heading": heading,
                    "markdown": part,
                    "text": plain_text,
                    "char_count": len(plain_text),
                }
            )

    return chunks


def parse_with_docling(path: Path, max_chars: int) -> dict[str, object]:
    extension = path.suffix.lower()
    if extension not in SUPPORTED_EXTENSIONS:
        allowed = ", ".join(sorted(SUPPORTED_EXTENSIONS))
        raise ValueError(f"Unsupported file type '{extension}'. Supported types: {allowed}.")

    try:
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions
        from docling.document_converter import DocumentConverter
        from docling.document_converter import PdfFormatOption
    except Exception as exc:  # pragma: no cover - exercised in local setup failures.
        raise RuntimeError(
            "Docling is not installed for this Python runtime. "
            "Install it with Python 3.10+ using: python -m pip install -r requirements.txt. "
            f"Import error: {exc}"
        ) from exc

    pdf_options = PdfPipelineOptions()
    pdf_options.document_timeout = 120
    artifacts_path = os.environ.get("DOCLING_ARTIFACTS_PATH")
    if artifacts_path:
        pdf_options.artifacts_path = artifacts_path

    converter = DocumentConverter(
        allowed_formats=[
            InputFormat.PDF,
            InputFormat.DOCX,
            InputFormat.PPTX,
            InputFormat.MD,
        ],
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=pdf_options),
        },
    )
    try:
        result = converter.convert(path)
    except Exception as exc:
        message = str(exc)
        if extension == ".pdf" and "snapshot folder" in message:
            raise RuntimeError(
                "Docling needs local PDF model artifacts before parsing PDFs offline. "
                "Run `docling-tools models download` and optionally set DOCLING_ARTIFACTS_PATH."
            ) from exc
        raise
    markdown = normalize_text(result.document.export_to_markdown())
    text = markdown_to_plain_text(markdown)
    chunks = chunk_markdown(markdown, max_chars)

    return {
        "parser": "docling",
        "source_name": path.name,
        "source_type": SUPPORTED_EXTENSIONS[extension],
        "markdown": markdown,
        "text": text,
        "chunks": chunks,
        "metadata": {
            "chunk_count": len(chunks),
            "char_count": len(text),
            "status": str(getattr(result, "status", "success")),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path)
    parser.add_argument("--max-chars", type=int, default=1800)
    args = parser.parse_args()

    try:
        payload = parse_with_docling(args.path, args.max_chars)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1

    print(json.dumps({"ok": True, **payload}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
