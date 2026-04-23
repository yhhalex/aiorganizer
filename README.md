# AI Document Organizer

AI Document Organizer is an intelligent document management system that helps users organize, search, and understand files across different document types. Instead of manually sorting through scattered PDFs, notes, slides, and text files, users can upload their materials into one storage system where AI automatically classifies content, suggests or creates folders, and provides concise answers to natural-language questions with references to the original sources.

In addition to traditional files, the system also supports saving shared links (such as ChatGPT conversations or online articles) as structured notes, making them searchable and usable alongside uploaded documents.

---

## Overview

Students and professionals often store large numbers of documents in messy, inconsistent folder structures. Important information becomes difficult to find, and searching manually through documents is time-consuming. This application solves that problem by combining document parsing, semantic search, and AI-powered summarization into a single workflow.

The system can:
- ingest documents of different types
- analyze document content and topic
- place documents into the most appropriate existing folder
- create a new folder when no suitable folder exists
- store shared links as searchable notes
- answer user questions with short, condensed responses
- provide references from stored documents and links

---

## Problem

Users regularly deal with:
- scattered notes, slides, PDFs, and reports
- inconsistent folder naming and organization
- difficulty finding specific information across many files
- valuable knowledge stored in external links (e.g., ChatGPT, articles) that is not organized
- wasted time opening multiple sources just to locate one answer

Traditional file systems rely on manual organization, and keyword search is often too limited to capture meaning. As a result, users may already have the information they need, but still struggle to retrieve it efficiently.

---

## Solution

AI Document Organizer acts as a smart knowledge layer on top of document storage.

When a user uploads a file or saves a shared link, the system:
1. extracts text and relevant content
2. analyzes the topic and context
3. compares it against existing folders
4. assigns it to the best-matching folder
5. creates a new folder if no suitable category exists

When a user asks a question, the system:
1. performs semantic search across all stored data (files and links)
2. retrieves the most relevant content
3. generates a short, condensed answer
4. returns references to the source files or saved links

---

## Features

### 1. Multi-Type Document Support
The application supports multiple document formats, including:
- PDF
- DOCX
- TXT
- Markdown
- Slides / presentation exports
- Other text-based academic or professional documents

---

### 2. AI-Powered Folder Organization
The system automatically determines whether a file or note belongs in:
- an existing folder
- a newly created folder if no existing category fits
- multiple relevant folders when the content fits more than one organizational view

Example:
- Operating systems notes -> `Computer Science / OS`
- Regression notes -> `Statistics / Regression`
- New topic -> system creates a new folder
- Machine Learning Class slides_4_10 -> both `CS3780` and `Machine Learning`

Folders can overlap by title or purpose, so the same file or saved link can appear in more than one folder. For example, a class-based folder such as `CLASS_NAME-CLASS_CODE (CS3780)` and a topic-based folder such as `TYPE_OF_INFORMATION (Machine Learning)` can both contain a link to `Machine Learning Class slides_4_10`.

---

### 3. Shared Links as Notes
Users can paste links such as:
- ChatGPT conversations
- Articles or blogs
- Documentation pages

The system will:
- extract and store the content
- treat it as a structured note
- organize it into folders
- include it in search and answers

---

### 4. Semantic Search
Instead of relying only on exact keywords, the application understands meaning. Users can ask natural-language questions such as:
- "What are the main ideas behind virtual memory?"
- "Summarize regression assumptions from my notes."
- "Which sources mention zoning compliance requirements?"

---

### 5. Condensed Answers with References
For each query, the system provides:
- a short, direct answer
- references to supporting sources, including:
  - document names
  - specific sections or chunks
  - saved link-based notes

This ensures transparency and allows users to verify the information.

---

### 6. Scalable Personal Knowledge Base
Over time, the application builds a structured, searchable knowledge base that allows users to:
- quickly review past materials
- reuse information
- study more efficiently

---

## Example Workflow

### Upload / Save Flow
1. User uploads a document or pastes a shared link
2. System extracts content
3. AI determines topic and context
4. System matches to existing folders or creates a new one
5. Content is stored and indexed for search

---

### Search Flow
1. User asks a question
2. System retrieves relevant content from documents and notes
3. AI generates a concise answer
4. System returns references

Example query:
> "What does my database lecture say about normalization?"

Example result:
> **Answer:** Normalization is the process of structuring a relational database to reduce redundancy and improve data integrity through forms such as 1NF, 2NF, and 3NF.
>
> **References:**
> - Database_Lecture_4.pdf
> - notes_week3.docx
> - chatgpt_notes_normalization

---

## System Architecture

The application consists of several components:

### Frontend
Handles:
- file upload and link input
- folder navigation
- search interface
- displaying answers and references

---

### Backend
Handles:
- document and link ingestion
- folder management
- API endpoints for search and organization

---

### AI / NLP Layer
Handles:
- text extraction and chunking
- embedding generation
- semantic similarity search
- summarization and answer generation
- folder classification logic

---

### Storage Layer
Handles:
- raw document storage
- saved link content
- folder metadata
- vector embeddings for retrieval

---

## Folder Assignment Logic

- Generate an embedding for each document or note
- Compare it with embeddings representing existing folders
- If similarity exceeds a threshold -> assign to that folder
- Otherwise -> create a new folder based on detected topic

---

## Search and Answering Logic

The system uses retrieval-augmented generation:

1. Convert user query into an embedding
2. Retrieve the most relevant document and note chunks
3. Provide these as context to the language model
4. Generate a concise answer
5. Return references to sources

---

## Tech Stack

Example stack:
- Frontend: React, Next.js, Tailwind CSS
- Backend: FastAPI or Node.js
- AI/NLP: embeddings + language model for summarization
- Vector DB: Chroma / Pinecone / Weaviate
- Database: PostgreSQL or MongoDB
- Storage: local or cloud-based

---

## Local Document Parsing

The prototype parses uploaded `pdf`, `docx`, `pptx`, and `md` files through a Next.js API route backed by Docling. The parser converts each file to Markdown, plain text, and chunk records that feed directly into embeddings and folder decisioning.

Install the Python parser dependency with Python 3.10+:

```bash
python -m pip install -r requirements.txt
```

If your Docling install lives in a non-default Python runtime, start Next with `DOCLING_PYTHON=/path/to/python`.

PDF parsing uses Docling's PDF pipeline. For offline PDF parsing, prefetch Docling's model artifacts with `docling-tools models download` and set `DOCLING_ARTIFACTS_PATH` if you store them outside Docling's default cache.

---

## Local Embedding Stage

Parsed chunks can be embedded through the server-side `/api/embed` route. The route calls OpenAI's embeddings API with `text-embedding-3-small`, returns float vectors, and keeps the API key out of browser code.

Set the key before running the app:

```bash
OPENAI_API_KEY=your_key npm run dev
```

Embeddings are stored locally on `document_chunks` records and mirrored to pgvector when `DATABASE_URL` is configured.

---

## Local pgvector Stage

The prototype includes a Postgres + pgvector setup for durable vector search. IndexedDB still drives the local UI state, while `/api/vector/upsert` mirrors sources, folders, folder assignments, chunks, and embeddings into Postgres. The Ask view tries `/api/vector/search` first and falls back to local IndexedDB vector search if pgvector is unavailable.

Start the local database:

```bash
docker compose up -d
```

Run the schema migration:

```bash
npm run db:migrate
```

Use the default local URL:

```bash
DATABASE_URL=postgres://aiorganizer:aiorganizer@127.0.0.1:55432/aiorganizer
```

The schema stores `sources`, `folders`, `folder_items`, `document_chunks`, and `folder_profiles`. Chunk and folder-profile embeddings use `vector(1536)` with HNSW cosine indexes for nearest-neighbor search.

---

## Folder Decisioning

After parsing and embedding, files are assigned with embedding similarity first and LLM decisioning second. New uploads now run through this path automatically instead of being staged in a temporary testing folder.

The upload flow and the Manage view's `Decide` action both:

1. Builds folder profiles from folder names, descriptions, assigned item titles, and representative chunk text.
2. Embeds those folder profiles.
3. Averages the new file's chunk embeddings into a document vector.
4. Compares the document vector and individual chunk vectors against folder-profile vectors.
5. Assigns directly to every existing folder whose similarity is at least `0.75`.
6. Calls the LLM only when no existing folder clears the threshold, asking whether to assign to a candidate folder or create a new folder.

The LLM endpoint is `/api/llm/folder-decision`. It returns a structured decision with `action`, `folder_id`, `new_folder_name`, `confidence`, and `reason`.

---

## Future Improvements

Potential extensions include:
- OCR for scanned documents
- duplicate detection
- tagging system in addition to folders
- collaborative shared folders
- personalized study recommendations
- browser extension for saving links directly

---
# aiorganizer
