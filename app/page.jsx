"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const DB_NAME = "ai-organizer-prototype";
const DB_VERSION = 4;
const STORE_NAMES = [
  "folders",
  "items",
  "folder_items",
  "folder_suggestions",
  "local_files",
  "document_chunks",
  "folder_profiles"
];
const LEGACY_DEVELOPMENT_TESTING_FOLDER_NAME = "development_testing_folder";
const LEGACY_DEVELOPMENT_ASSIGNMENT_TYPE = "development_testing";
const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;
const EMBEDDING_BATCH_SIZE = 64;
const FOLDER_MATCH_THRESHOLD = 0.6;
const QUERY_MATCH_THRESHOLD = 0.35;
const LLM_DECISION_MODEL = "gpt-4o-mini";
const LLM_QUERY_MODEL = "gpt-4o-mini";

// DEBUG: upload + foldering pipeline logs (client console). Keep off in production.
const DEBUG_UPLOAD_LOGS = process.env.NODE_ENV !== "production";

// DEBUG: wrapper so we can easily grep console output.
function debugUpload(...args) {
  if (!DEBUG_UPLOAD_LOGS) return;
  // eslint-disable-next-line no-console
  console.debug("[ai-organizer][upload]", ...args);
}

function createId(prefix) {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function timestamp() {
  return new Date().toISOString();
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains("folders")) {
        const store = db.createObjectStore("folders", { keyPath: "id" });
        store.createIndex("name", "name", { unique: false });
      }

      if (!db.objectStoreNames.contains("items")) {
        const store = db.createObjectStore("items", { keyPath: "id" });
        store.createIndex("status", "status", { unique: false });
      }

      if (!db.objectStoreNames.contains("folder_items")) {
        const store = db.createObjectStore("folder_items", { keyPath: "id" });
        store.createIndex("folder_id", "folder_id", { unique: false });
        store.createIndex("item_id", "item_id", { unique: false });
      }

      if (!db.objectStoreNames.contains("folder_suggestions")) {
        const store = db.createObjectStore("folder_suggestions", { keyPath: "id" });
        store.createIndex("item_id", "item_id", { unique: false });
        store.createIndex("status", "status", { unique: false });
      }

      if (!db.objectStoreNames.contains("local_files")) {
        const store = db.createObjectStore("local_files", { keyPath: "id" });
        store.createIndex("item_id", "item_id", { unique: false });
        store.createIndex("file_name", "file_name", { unique: false });
      }

      if (!db.objectStoreNames.contains("document_chunks")) {
        const store = db.createObjectStore("document_chunks", { keyPath: "id" });
        store.createIndex("item_id", "item_id", { unique: false });
        store.createIndex("embedding_status", "embedding_status", { unique: false });
      }

      if (!db.objectStoreNames.contains("folder_profiles")) {
        const store = db.createObjectStore("folder_profiles", { keyPath: "id" });
        store.createIndex("folder_id", "folder_id", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName).objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function putRecord(db, storeName, value) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readwrite").objectStore(storeName).put(value);
    request.onsuccess = () => resolve(value);
    request.onerror = () => reject(request.error);
  });
}

function deleteRecord(db, storeName, id) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readwrite").objectStore(storeName).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatBytes(value) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** index;
  return `${amount.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function excerptForQuery(text, query, maxChars = 140) {
  const source = String(text || "").replace(/\s+/g, " ").trim();
  if (!source) return "";
  if (!query?.trim()) return source.slice(0, maxChars);
  if (source.length <= maxChars) return source;

  const normalizedSource = source.toLowerCase();
  const tokens = String(query)
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9_-]+/g, ""))
    .filter((token) => token.length >= 3);

  let matchIndex = -1;
  for (const token of tokens) {
    const index = normalizedSource.indexOf(token);
    if (index !== -1 && (matchIndex === -1 || index < matchIndex)) {
      matchIndex = index;
    }
  }

  const windowStart = matchIndex === -1 ? 0 : Math.max(0, matchIndex - Math.floor(maxChars * 0.25));
  const windowEnd = Math.min(source.length, windowStart + maxChars);
  let excerpt = source.slice(windowStart, windowEnd);

  if (windowStart > 0) excerpt = `…${excerpt}`;
  if (windowEnd < source.length) excerpt = `${excerpt}…`;
  return excerpt;
}

function chunkPlainText(text, maxChars = 1800) {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const chunks = [];
  let current = "";

  paragraphs.forEach((paragraph) => {
    if (current && current.length + paragraph.length + 2 > maxChars) {
      chunks.push(current);
      current = paragraph;
      return;
    }

    current = [current, paragraph].filter(Boolean).join("\n\n");
  });

  if (current) chunks.push(current);

  return chunks.map((chunk, index) => ({
    index,
    heading: "Note",
    markdown: chunk,
    text: chunk,
    char_count: chunk.length
  }));
}

function parseNoteContent(content) {
  const text = content.trim();
  const chunks = chunkPlainText(text);
  return {
    parser: "plain-text",
    source_type: "note",
    markdown: text,
    text,
    chunks,
    metadata: {
      chunk_count: chunks.length,
      char_count: text.length
    }
  };
}

async function parseFileWithDocling(file) {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch("/api/parse", {
    method: "POST",
    body: formData
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || "File could not be parsed.");
  }

  return payload;
}

async function createEmbeddings(input) {
  const response = await fetch("/api/embed", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      input,
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS
    })
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || "Embeddings could not be created.");
  }

  return payload;
}

async function syncPgvector(payload) {
  const response = await fetch("/api/vector/upsert", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok || !body.ok) {
    throw new Error(body.error || "pgvector sync failed.");
  }

  return body;
}

async function searchPgvector(embedding, limit = 5) {
  const response = await fetch("/api/vector/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ embedding, limit })
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok || !body.ok) {
    throw new Error(body.error || "pgvector search failed.");
  }

  return body.results || [];
}

async function askLLMForFolderDecision(payload) {
  const response = await fetch("/api/llm/folder-decision", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      ...payload,
      model: LLM_DECISION_MODEL
    })
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok || !body.ok) {
    const details = body.details && typeof body.details === "object"
      ? body.details
      : null;
    const preview = details?.output_preview ? ` Output preview: ${details.output_preview}` : "";
    const parseError = details?.parse_error ? ` Parse error: ${details.parse_error}` : "";
    throw new Error(`${body.error || "LLM folder decision failed."}${parseError}${preview}`.trim());
  }

  return body.decision;
}

async function askLLMForQueryAnswer(payload) {
  const response = await fetch("/api/llm/query-answer", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      ...payload,
      model: LLM_QUERY_MODEL
    })
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok || !body.ok) {
    throw new Error(body.error || "LLM query answering failed.");
  }

  return {
    answer: String(body.answer || "").trim(),
    citedItemIds: Array.isArray(body.cited_item_ids)
      ? body.cited_item_ids.map((value) => String(value || "")).filter(Boolean)
      : []
  };
}

function averageEmbeddings(embeddings) {
  const usable = embeddings.filter((embedding) => Array.isArray(embedding) && embedding.length);
  if (!usable.length) return [];

  const dimensions = usable[0].length;
  const average = Array(dimensions).fill(0);

  usable.forEach((embedding) => {
    embedding.forEach((value, index) => {
      average[index] += value;
    });
  });

  return average.map((value) => value / usable.length);
}

function cosineSimilarity(left, right) {
  if (!left?.length || !right?.length || left.length !== right.length) return 0;

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }

  if (!leftMagnitude || !rightMagnitude) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function normalizeNewFolderName(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return "";

  // Keep this intentionally small and conservative: strip common "too-specific" suffix words.
  const dropWords = new Set([
    "technique",
    "techniques",
    "method",
    "methods",
    "optimization",
    "optimizations",
    "slides",
    "slide",
    "lecture",
    "lectures",
    "notes",
    "note"
  ]);

  const words = trimmed.split(/\s+/).filter(Boolean);
  while (words.length > 1 && dropWords.has(words[words.length - 1].toLowerCase())) {
    words.pop();
  }

  return words.join(" ").trim();
}

export default function Home() {
  const dbRef = useRef(null);
  const [activeView, setActiveView] = useState("ask");
  const [selectedFolderId, setSelectedFolderId] = useState(null);
  const [folderFormOpen, setFolderFormOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [folderDescription, setFolderDescription] = useState("");
  const [folderError, setFolderError] = useState("");
  const [itemType, setItemType] = useState("file");
  const [itemTitle, setItemTitle] = useState("");
  const [itemContent, setItemContent] = useState("");
  const [itemFile, setItemFile] = useState(null);
  const [itemError, setItemError] = useState("");
  const [itemStatus, setItemStatus] = useState("");
  const [itemSaving, setItemSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [queryResults, setQueryResults] = useState([]);
  const [queryError, setQueryError] = useState("");
  const [querySearching, setQuerySearching] = useState(false);
  const [queryAnswer, setQueryAnswer] = useState("");
  const [querySourceItemIds, setQuerySourceItemIds] = useState([]);
  const [embeddingStatus, setEmbeddingStatus] = useState("");
  const [embeddingError, setEmbeddingError] = useState("");
  const [embeddingSaving, setEmbeddingSaving] = useState(false);
  const [decisionStatus, setDecisionStatus] = useState("");
  const [decisionError, setDecisionError] = useState("");
  const [decisionSaving, setDecisionSaving] = useState(false);
  const [vectorStatus, setVectorStatus] = useState("");
  const [vectorError, setVectorError] = useState("");
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [data, setData] = useState({
    folders: [],
    items: [],
    folderItems: [],
    suggestions: [],
    localFiles: [],
    documentChunks: [],
    folderProfiles: []
  });

  async function ensureDb() {
    if (dbRef.current) return dbRef.current;
    if (!("indexedDB" in window)) {
      throw new Error("IndexedDB is not available in this browser.");
    }

    const nextDb = await openDatabase();
    dbRef.current = nextDb;
    setStorageReady(true);
    setStorageError("");
    return nextDb;
  }

  async function refresh(nextDb = dbRef.current) {
    const liveDb = nextDb || (await ensureDb());

    const [folders, items, folderItems, suggestions, localFiles, documentChunks, folderProfiles] = await Promise.all(
      STORE_NAMES.map((storeName) => getAll(liveDb, storeName))
    );

    setData({
      folders: folders.sort((a, b) => a.name.localeCompare(b.name)),
      items: items.sort((a, b) => b.created_at.localeCompare(a.created_at)),
      folderItems,
      suggestions: suggestions.sort((a, b) => b.created_at.localeCompare(a.created_at)),
      localFiles,
      documentChunks,
      folderProfiles
    });
  }

  async function cleanupLegacyTestingFolder(liveDb) {
    const [folders, folderItems, folderProfiles] = await Promise.all([
      getAll(liveDb, "folders"),
      getAll(liveDb, "folder_items"),
      getAll(liveDb, "folder_profiles")
    ]);
    const legacyFolders = folders.filter(
      (folder) => folder.name.toLowerCase() === LEGACY_DEVELOPMENT_TESTING_FOLDER_NAME.toLowerCase()
    );
    if (!legacyFolders.length) return;

    const legacyFolderIds = new Set(legacyFolders.map((folder) => folder.id));
    const legacyRelations = folderItems.filter((row) => legacyFolderIds.has(row.folder_id));
    const legacyProfiles = folderProfiles.filter((profile) => legacyFolderIds.has(profile.folder_id));

    await Promise.all([
      ...legacyRelations.map((row) => deleteRecord(liveDb, "folder_items", row.id)),
      ...legacyProfiles.map((profile) => deleteRecord(liveDb, "folder_profiles", profile.id)),
      ...legacyFolders.map((folder) => deleteRecord(liveDb, "folders", folder.id))
    ]);
  }

  useEffect(() => {
    let mounted = true;

    async function boot() {
      const nextDb = await ensureDb();
      if (!mounted) return;
      await cleanupLegacyTestingFolder(nextDb);
      await refresh(nextDb);
    }

    boot().catch((error) => {
      console.error(error);
      setStorageError(error.message || "Local storage could not start.");
    });

    return () => {
      mounted = false;
    };
  }, []);

  const pendingSuggestions = useMemo(
    () => data.suggestions.filter((suggestion) => suggestion.status === "pending"),
    [data.suggestions]
  );
  const pendingEmbeddingChunks = useMemo(
    () => data.documentChunks.filter((chunk) => chunk.text?.trim() && chunk.embedding_status !== "embedded"),
    [data.documentChunks]
  );
  const embeddedChunks = useMemo(
    () => data.documentChunks.filter((chunk) => Array.isArray(chunk.embedding) && chunk.embedding.length),
    [data.documentChunks]
  );
  const decisionCandidateItems = useMemo(
    () => data.items.filter((item) => item.status === "embedded" && item.staged_for === "llm_decision"),
    [data.items]
  );
  const realFolders = useMemo(
    () => data.folders.filter(
      (folder) => folder.name.toLowerCase() !== LEGACY_DEVELOPMENT_TESTING_FOLDER_NAME.toLowerCase()
    ),
    [data.folders]
  );

  const selectedFolder = data.folders.find((folder) => folder.id === selectedFolderId) || null;
  const selectedFolderItems = selectedFolder
    ? data.items.filter((item) =>
      data.folderItems.some((row) => row.folder_id === selectedFolder.id && row.item_id === item.id)
    )
    : [];
  const hasQuery = submittedQuery.trim().length > 0;
  const topRelevantResult = queryResults[0] || null;
  const querySourceResults = querySourceItemIds.length
    ? queryResults.filter(({ item }) => querySourceItemIds.includes(item.id))
    : topRelevantResult
      ? [topRelevantResult]
      : [];

  function folderCount(folderId) {
    return data.folderItems.filter((row) => row.folder_id === folderId).length;
  }

  function itemById(itemId) {
    return data.items.find((item) => item.id === itemId);
  }

  function folderById(folderId) {
    return data.folders.find((folder) => folder.id === folderId);
  }

  function fileCopyForItem(item) {
    if (!item) return null;
    return data.localFiles.find((file) => file.id === item.local_file_id || file.item_id === item.id) || null;
  }

  function chunkCountForItem(itemId) {
    return data.documentChunks.filter((chunk) => chunk.item_id === itemId).length;
  }

  function embeddedChunkCountForItem(itemId) {
    return data.documentChunks.filter(
      (chunk) => chunk.item_id === itemId && chunk.embedding_status === "embedded"
    ).length;
  }

  function folderNameForItem(itemId) {
    const relation = data.folderItems.find((row) => row.item_id === itemId);
    return relation ? folderById(relation.folder_id)?.name || "Unfiled" : "Unfiled";
  }

  function pgvectorSourceForItem(item) {
    return {
      source_id: item.source_id || item.id,
      source_type: item.source_type || item.parser_source_type || item.type,
      title: item.title,
      raw_text: item.raw_text || item.content_text || "",
      metadata: item.metadata || {},
      parser: item.parser || "unknown",
      created_at: item.created_at,
      updated_at: item.updated_at
    };
  }

  function chunksForItem(itemId) {
    return data.documentChunks
      .filter((chunk) => chunk.item_id === itemId)
      .sort((left, right) => left.chunk_index - right.chunk_index);
  }

  function rankLocalChunkMatches(queryEmbedding) {
    return embeddedChunks
      .map((chunk) => ({
        chunk,
        item: itemById(chunk.item_id),
        folderName: folderNameForItem(chunk.item_id),
        score: cosineSimilarity(queryEmbedding, chunk.embedding)
      }))
      .filter((result) => result.item)
      .sort((left, right) => right.score - left.score);
  }

  function buildQueryMatchesFromRankedChunks(rankedResults, preferredItemIds = [], limit = 5) {
    const resultsByItemId = new Map();

    rankedResults
      .filter((result) => result.score >= QUERY_MATCH_THRESHOLD)
      .forEach((result) => {
        const itemId = result.item.id;
        if (!resultsByItemId.has(itemId)) {
          resultsByItemId.set(itemId, {
            ...result,
            contextChunks: [{
              id: result.chunk.id,
              chunk_index: result.chunk.chunk_index,
              heading: result.chunk.heading,
              text: result.chunk.text,
              score: result.score
            }]
          });
          return;
        }

        const existing = resultsByItemId.get(itemId);
        if (existing.contextChunks.length >= 3) return;
        existing.contextChunks.push({
          id: result.chunk.id,
          chunk_index: result.chunk.chunk_index,
          heading: result.chunk.heading,
          text: result.chunk.text,
          score: result.score
        });
      });

    const orderedItemIds = [];
    preferredItemIds.forEach((itemId) => {
      if (resultsByItemId.has(itemId) && !orderedItemIds.includes(itemId)) {
        orderedItemIds.push(itemId);
      }
    });

    [...resultsByItemId.values()]
      .sort((left, right) => right.score - left.score)
      .forEach((result) => {
        if (!orderedItemIds.includes(result.item.id)) {
          orderedItemIds.push(result.item.id);
        }
      });

    return orderedItemIds
      .slice(0, limit)
      .map((itemId) => resultsByItemId.get(itemId))
      .filter(Boolean);
  }

  function buildQueryMatchesFromPgResults(pgResults, limit = 5) {
    return pgResults
      .filter((result) => (Number(result.score) || 0) >= QUERY_MATCH_THRESHOLD)
      .slice(0, limit)
      .map((result) => {
        const score = Number(result.score) || 0;
        const item = itemById(result.item_id) || {
          id: result.item_id || result.source_id,
          title: result.source_title,
          source_type: result.source_type
        };

        return {
          chunk: {
            id: result.id,
            chunk_index: result.chunk_index,
            heading: result.heading,
            text: result.text
          },
          item,
          folderName: result.folder_name,
          score,
          contextChunks: [{
            id: result.id,
            chunk_index: result.chunk_index,
            heading: result.heading,
            text: result.text,
            score
          }]
        };
      });
  }

  function buildQueryAnswerSources(results) {
    return results.map(({ item, folderName, score, contextChunks }) => {
      const sourceChunks = contextChunks.length
        ? contextChunks
        : [{
          chunk_index: 0,
          heading: item.title || "Document",
          text: item.raw_text || item.content_text || "",
          score
        }];

      return {
        item_id: item.id,
        title: item.title || "Untitled",
        source_type: item.source_type || item.type || "unknown",
        folder_name: folderName || folderNameForItem(item.id),
        score,
        chunks: sourceChunks.map((chunk) => ({
          chunk_index: chunk.chunk_index || 0,
          heading: chunk.heading || "Document",
          text: String(chunk.text || "").slice(0, 1200),
          score: Number(chunk.score) || 0
        }))
      };
    });
  }

  async function retrieveTopQueryMatches(queryEmbedding, limit = 5) {
    const localRankedResults = rankLocalChunkMatches(queryEmbedding);
    let uniquePgResults = [];

    try {
      const pgResults = await searchPgvector(queryEmbedding, 20);
      const bestByItemId = new Map();
      pgResults.forEach((result) => {
        const itemId = result.item_id || result.source_id || "";
        const score = Number(result.score) || 0;
        const existing = itemId ? bestByItemId.get(itemId) : null;
        if (!itemId) return;
        if (!existing || score > (Number(existing.score) || 0)) {
          bestByItemId.set(itemId, { ...result, score });
        }
      });
      uniquePgResults = [...bestByItemId.values()]
        .sort((left, right) => (Number(right.score) || 0) - (Number(left.score) || 0));

      if (uniquePgResults.length) {
        setVectorStatus("pgvector semantic search complete.");
        setVectorError("");
      } else {
        setVectorStatus("");
        setVectorError("");
      }
    } catch (error) {
      setVectorStatus("");
      setVectorError(`pgvector search skipped: ${error.message}`);
    }

    if (localRankedResults.length) {
      const preferredItemIds = uniquePgResults.map((result) => result.item_id || result.source_id).filter(Boolean);
      const localMatches = buildQueryMatchesFromRankedChunks(localRankedResults, preferredItemIds, limit);
      if (localMatches.length) return localMatches;
    }

    if (uniquePgResults.length) {
      return buildQueryMatchesFromPgResults(uniquePgResults, limit);
    }

    return [];
  }

  function buildFolderProfileText(folder) {
    const relations = data.folderItems.filter(
      (row) => row.folder_id === folder.id && row.assignment_type !== LEGACY_DEVELOPMENT_ASSIGNMENT_TYPE
    );
    const relatedItems = relations
      .map((row) => itemById(row.item_id))
      .filter(Boolean)
      .slice(0, 8);
    const itemSummaries = relatedItems.map((item) => {
      const snippet = chunksForItem(item.id)[0]?.text?.slice(0, 320) || item.raw_text?.slice(0, 320) || "";
      return `- ${item.title}: ${snippet}`;
    });

    return [
      `Folder: ${folder.name}`,
      folder.description ? `Description: ${folder.description}` : "",
      itemSummaries.length ? `Known contents:\n${itemSummaries.join("\n")}` : ""
    ].filter(Boolean).join("\n\n");
  }

  function localFolderProfileFor(folderId) {
    return data.folderProfiles.find((profile) => profile.folder_id === folderId);
  }

  async function ensureFolderProfiles(liveDb) {
    debugUpload("folder profiles: ensure start", { folder_count: realFolders.length });
    const profiles = [];
    const foldersToProfile = realFolders;

    for (let index = 0; index < foldersToProfile.length; index += EMBEDDING_BATCH_SIZE) {
      const batch = foldersToProfile.slice(index, index + EMBEDDING_BATCH_SIZE);
      const profileInputs = batch.map((folder) => ({
        folder,
        profileText: buildFolderProfileText(folder)
      }));
      const changedInputs = profileInputs.filter(({ folder, profileText }) => {
        const existing = localFolderProfileFor(folder.id);
        return !existing?.embedding?.length || existing.profile_text !== profileText;
      });

      if (changedInputs.length) {
        debugUpload("folder profiles: embedding batch", {
          batch_size: batch.length,
          changed: changedInputs.length
        });
        const payload = await createEmbeddings(changedInputs.map((entry) => entry.profileText));
        const now = timestamp();
        const records = changedInputs.map(({ folder, profileText }, embeddingIndex) => {
            const record = {
              id: `folder_profile:${folder.id}`,
              folder_id: folder.id,
              profile_text: profileText,
              metadata: {
                folder_name: folder.name,
                item_count: data.folderItems.filter(
                  (row) => row.folder_id === folder.id && row.assignment_type !== LEGACY_DEVELOPMENT_ASSIGNMENT_TYPE
                ).length
              },
              embedding: payload.embeddings[embeddingIndex],
              embedding_model: payload.model || EMBEDDING_MODEL,
              embedding_dimensions: payload.dimensions || EMBEDDING_DIMENSIONS,
              created_at: localFolderProfileFor(folder.id)?.created_at || now,
              updated_at: now
            };
            profiles.push(record);
            return record;
          });
        await Promise.all(records.map((record) => putRecord(liveDb, "folder_profiles", record)));
        try {
          await syncPgvector({ folders: changedInputs.map((entry) => entry.folder), folderProfiles: records });
          setVectorStatus("pgvector synced folder profiles.");
          setVectorError("");
        } catch (error) {
          setVectorStatus("");
          setVectorError(`pgvector sync skipped: ${error.message}`);
        }
      }

      profileInputs.forEach(({ folder }) => {
        const existing = localFolderProfileFor(folder.id);
        if (existing && !profiles.some((profile) => profile.folder_id === folder.id)) {
          profiles.push(existing);
        }
      });
    }

    debugUpload("folder profiles: ensure done", { profile_count: profiles.length });
    return profiles;
  }

  function compareDocumentToFolderProfiles(item, profiles, itemChunks = chunksForItem(item.id)) {
    const embeddedItemChunks = itemChunks.filter((chunk) => Array.isArray(chunk.embedding) && chunk.embedding.length);
    const itemEmbedding = averageEmbeddings(embeddedItemChunks.map((chunk) => chunk.embedding));
    if (!itemEmbedding.length) return [];

    return profiles
      .map((profile) => {
        const averageScore = cosineSimilarity(itemEmbedding, profile.embedding);
        const chunkScore = Math.max(
          0,
          ...embeddedItemChunks.map((chunk) => cosineSimilarity(chunk.embedding, profile.embedding))
        );
        const score = Math.max(averageScore, chunkScore);

        return {
          folder: folderById(profile.folder_id),
          profile,
          score,
          average_score: averageScore,
          chunk_score: chunkScore
        };
      })
      .filter((result) => result.folder)
      .sort((left, right) => right.score - left.score);
  }

  async function embedChunkRecords(liveDb, chunks, reportStatus = () => {}) {
    const embeddableChunks = chunks.filter((chunk) => chunk.text?.trim());
    if (!embeddableChunks.length) return chunks;

    const updatedById = new Map(chunks.map((chunk) => [chunk.id, chunk]));

    for (let offset = 0; offset < embeddableChunks.length; offset += EMBEDDING_BATCH_SIZE) {
      const batch = embeddableChunks.slice(offset, offset + EMBEDDING_BATCH_SIZE);
      reportStatus(`Embedding ${offset + 1}-${offset + batch.length} of ${embeddableChunks.length} chunks...`);
      debugUpload("embeddings: chunk batch", {
        offset,
        batch: batch.length,
        total: embeddableChunks.length
      });

      const payload = await createEmbeddings(batch.map((chunk) => chunk.text));
      const now = timestamp();
      const updatedChunks = batch.map((chunk, index) => ({
        ...chunk,
        embedding: payload.embeddings[index],
        embedding_model: payload.model || EMBEDDING_MODEL,
        embedding_dimensions: payload.dimensions || EMBEDDING_DIMENSIONS,
        embedding_status: "embedded",
        embedded_at: now,
        updated_at: now
      }));

      await Promise.all(updatedChunks.map((chunk) => putRecord(liveDb, "document_chunks", chunk)));
      updatedChunks.forEach((chunk) => updatedById.set(chunk.id, chunk));
    }

    return chunks.map((chunk) => updatedById.get(chunk.id) || chunk);
  }

  async function markItemEmbedded(liveDb, item, itemChunks) {
    const now = timestamp();
    const embeddedChunkCount = itemChunks.filter((chunk) => chunk.embedding_status === "embedded").length;
    const updatedItem = {
      ...item,
      status: "embedded",
      embedding_status: embeddedChunkCount ? "embedded" : "not_applicable",
      embedding_model: EMBEDDING_MODEL,
      embedding_dimensions: EMBEDDING_DIMENSIONS,
      embedded_chunk_count: embeddedChunkCount,
      staged_for: "llm_decision",
      updated_at: now
    };

    await putRecord(liveDb, "items", updatedItem);
    return updatedItem;
  }

  async function decideFolderForEmbeddedItem(liveDb, item, itemChunks = chunksForItem(item.id), profiles = null) {
    const folderProfiles = profiles || await ensureFolderProfiles(liveDb);
    const rankedProfiles = compareDocumentToFolderProfiles(item, folderProfiles, itemChunks);
    const best = rankedProfiles[0] || null;
    const eligibleMatches = rankedProfiles.filter((result) => result.score >= FOLDER_MATCH_THRESHOLD);

    debugUpload("folder decision: similarity ranked", {
      item_id: item.id,
      title: item.title,
      threshold: FOLDER_MATCH_THRESHOLD,
      top: rankedProfiles.slice(0, 5).map((result) => ({
        folder: result.folder.name,
        score: Math.round(result.score * 1000) / 1000
      }))
    });

    if (eligibleMatches.length) {
      debugUpload("folder decision: similarity matched", {
        item_id: item.id,
        matched_folders: eligibleMatches.map((match) => match.folder.name),
        best_score: best ? Math.round(best.score * 1000) / 1000 : 0
      });
      return assignItemToFinalFolders(liveDb, item, eligibleMatches.map((match) => match.folder), {
        decision_source: "embedding_similarity",
        similarity_score: best.score,
        matched_folders: eligibleMatches.map((match) => ({
          folder_id: match.folder.id,
          folder_name: match.folder.name,
          similarity_score: match.score,
          average_score: match.average_score,
          chunk_score: match.chunk_score
        })),
        reason: `${eligibleMatches.length} folder profile${eligibleMatches.length === 1 ? "" : "s"} met threshold ${(FOLDER_MATCH_THRESHOLD * 100).toFixed(0)}%.`
      }, itemChunks);
    }

    debugUpload("folder decision: fallback to LLM", {
      item_id: item.id,
      candidate_count: rankedProfiles.length,
      candidates: rankedProfiles.slice(0, 20).map((result) => ({
        folder: result.folder.name,
        score: Math.round(result.score * 1000) / 1000
      }))
    });

    const decision = await askLLMForFolderDecision({
      item: {
        source_id: item.source_id || item.id,
        title: item.title,
        source_type: item.source_type || item.type,
        raw_text: (item.raw_text || item.content_text || "").slice(0, 4000),
        chunks: itemChunks.slice(0, 6).map((chunk) => ({
          heading: chunk.heading,
          text: chunk.text.slice(0, 900)
        }))
      },
      candidates: rankedProfiles.slice(0, 20).map(({ folder, profile, score }) => ({
        folder_id: folder.id,
        name: folder.name,
        description: folder.description || "",
        similarity_score: score,
        profile_text: (profile?.profile_text || "").slice(0, 900)
      })),
      threshold: FOLDER_MATCH_THRESHOLD
    });

    debugUpload("folder decision: LLM response", {
      item_id: item.id,
      action: decision.action,
      folder_id: decision.folder_id,
      new_folder_name: decision.new_folder_name,
      confidence: decision.confidence
    });

    const selectedFolder = decision.action === "assign_existing"
      ? folderById(decision.folder_id)
      : null;
    if (decision.action === "assign_existing" && !selectedFolder) {
      throw new Error("LLM chose assign_existing but returned an unknown folder_id.");
    }
    const requestedFolderName = normalizeNewFolderName(decision.new_folder_name) || "New Topic";
    const existingNamedFolder = realFolders.find(
      (folder) => folder.name.toLowerCase() === requestedFolderName.toLowerCase()
    );
    debugUpload("folder decision: resolve folder", {
      item_id: item.id,
      requested_name: requestedFolderName,
      resolved: selectedFolder
        ? { source: "llm_existing_id", folder: selectedFolder.name, folder_id: selectedFolder.id }
        : existingNamedFolder
          ? { source: "llm_existing_name", folder: existingNamedFolder.name, folder_id: existingNamedFolder.id }
          : { source: "llm_new_folder" }
    });
    const folder = selectedFolder || existingNamedFolder || await createFolderRecord(
      requestedFolderName,
      decision.new_folder_description || "Created by LLM folder decisioning.",
      liveDb
    );

    return assignItemToFinalFolders(liveDb, item, [folder], {
      decision_source: selectedFolder || existingNamedFolder ? "llm_existing_folder" : "llm_new_folder",
      similarity_score: best?.score || 0,
      reason: decision.reason || "LLM resolved a low-confidence folder decision.",
      llm_model: LLM_DECISION_MODEL
    }, itemChunks);
  }

  async function embedPendingChunks() {
    setEmbeddingError("");
    setEmbeddingStatus("");

    if (!pendingEmbeddingChunks.length) {
      setEmbeddingStatus("All parsed chunks are embedded.");
      return;
    }

    setEmbeddingSaving(true);
    try {
      const liveDb = await ensureDb();
      const affectedItemIds = new Set();

      for (let offset = 0; offset < pendingEmbeddingChunks.length; offset += EMBEDDING_BATCH_SIZE) {
        const batch = pendingEmbeddingChunks.slice(offset, offset + EMBEDDING_BATCH_SIZE);
        setEmbeddingStatus(`Embedding ${offset + 1}-${offset + batch.length} of ${pendingEmbeddingChunks.length} chunks...`);

        const payload = await createEmbeddings(batch.map((chunk) => chunk.text));
        const now = timestamp();
        const updatedChunks = batch.map((chunk, index) => ({
          ...chunk,
          embedding: payload.embeddings[index],
          embedding_model: payload.model || EMBEDDING_MODEL,
          embedding_dimensions: payload.dimensions || EMBEDDING_DIMENSIONS,
          embedding_status: "embedded",
          embedded_at: now,
          updated_at: now
        }));

        await Promise.all(
          updatedChunks.map((chunk) => {
            affectedItemIds.add(chunk.item_id);
            return putRecord(liveDb, "document_chunks", chunk);
          })
        );

        try {
          const batchItems = [...new Set(updatedChunks.map((chunk) => chunk.item_id))]
            .map((itemId) => itemById(itemId))
            .filter(Boolean);
          await syncPgvector({
            sources: batchItems.map(pgvectorSourceForItem),
            chunks: updatedChunks
          });
          setVectorStatus(`pgvector synced ${offset + batch.length} embedded chunks.`);
          setVectorError("");
        } catch (error) {
          setVectorStatus("");
          setVectorError(`pgvector sync skipped: ${error.message}`);
        }
      }

      const now = timestamp();
      await Promise.all(
        [...affectedItemIds].map((itemId) => {
          const item = itemById(itemId);
          if (!item) return Promise.resolve();
          const itemChunks = data.documentChunks.filter((chunk) => chunk.item_id === itemId);
          return putRecord(liveDb, "items", {
            ...item,
            status: "embedded",
            embedding_status: "embedded",
            embedding_model: EMBEDDING_MODEL,
            embedding_dimensions: EMBEDDING_DIMENSIONS,
            embedded_chunk_count: itemChunks.length,
            staged_for: "llm_decision",
            updated_at: now
          });
        })
      );

      setEmbeddingStatus("Embedding stage complete.");
      await refresh(liveDb);
    } catch (error) {
      setEmbeddingError(error.message || "Embeddings could not be created.");
      setEmbeddingStatus("");
    } finally {
      setEmbeddingSaving(false);
    }
  }

  async function decideFoldersForEmbeddedItems() {
    setDecisionError("");
    setDecisionStatus("");

    if (!decisionCandidateItems.length) {
      setDecisionStatus("No embedded staged items are waiting for folder decisions.");
      return;
    }

    setDecisionSaving(true);
    try {
      const liveDb = await ensureDb();
      setDecisionStatus("Updating folder profiles...");
      const profiles = await ensureFolderProfiles(liveDb);

      for (const item of decisionCandidateItems) {
        setDecisionStatus(`Deciding folder for ${item.title}...`);
        await decideFolderForEmbeddedItem(liveDb, item, chunksForItem(item.id), profiles);
      }

      setDecisionStatus("Folder decisioning complete.");
      await refresh(liveDb);
    } catch (error) {
      setDecisionError(error.message || "Folder decisioning failed.");
      setDecisionStatus("");
    } finally {
      setDecisionSaving(false);
    }
  }

  async function assignItemToFinalFolders(liveDb, item, folders, decision, itemChunks = chunksForItem(item.id)) {
    const now = timestamp();
    const uniqueFolders = [...new Map(folders.filter(Boolean).map((folder) => [folder.id, folder])).values()];
    if (!uniqueFolders.length) {
      throw new Error("At least one folder is required for folder assignment.");
    }

    debugUpload("folder assignment: start", {
      item_id: item.id,
      title: item.title,
      decision_source: decision.decision_source,
      folders: uniqueFolders.map((folder) => folder.name)
    });

    const stagingRelations = data.folderItems.filter(
      (row) => row.item_id === item.id && row.assignment_type === LEGACY_DEVELOPMENT_ASSIGNMENT_TYPE
    );
    const relations = uniqueFolders.map((folder) => ({
      id: `${folder.id}:${item.id}`,
      folder_id: folder.id,
      source_id: item.source_id || item.id,
      item_id: item.id,
      assignment_type: decision.decision_source,
      created_at: now
    }));
    const primaryFolder = uniqueFolders[0];
    const updatedItem = {
      ...item,
      status: "assigned",
      staged_for: "",
      assigned_folder_id: primaryFolder.id,
      assigned_folder_ids: uniqueFolders.map((folder) => folder.id),
      folder_decision: {
        ...decision,
        folder_id: primaryFolder.id,
        folder_name: primaryFolder.name,
        folder_ids: uniqueFolders.map((folder) => folder.id),
        folder_names: uniqueFolders.map((folder) => folder.name),
        decided_at: now
      },
      updated_at: now
    };

    await Promise.all([
      ...stagingRelations.map((row) => deleteRecord(liveDb, "folder_items", row.id)),
      ...uniqueFolders.map((folder) => putRecord(liveDb, "folders", folder)),
      ...relations.map((relation) => putRecord(liveDb, "folder_items", relation)),
      putRecord(liveDb, "items", updatedItem)
    ]);

    try {
      await syncPgvector({
        source: pgvectorSourceForItem(updatedItem),
        folders: uniqueFolders,
        folderItems: relations,
        chunks: itemChunks,
        deleteFolderItemIds: stagingRelations.map((row) => row.id)
      });
      setVectorStatus("pgvector synced folder decision.");
      setVectorError("");
    } catch (error) {
      setVectorStatus("");
      setVectorError(`pgvector sync skipped: ${error.message}`);
    }

    setSelectedFolderId(primaryFolder.id);
    debugUpload("folder assignment: done", {
      item_id: item.id,
      primary_folder: primaryFolder.name,
      folders: uniqueFolders.map((folder) => folder.name)
    });
    return updatedItem;
  }

  async function searchEmbeddedChunks(event) {
    event.preventDefault();
    const trimmedQuery = query.trim();
    setSubmittedQuery(trimmedQuery);
    setQueryError("");
    setQueryResults([]);
    setQueryAnswer("");
    setQuerySourceItemIds([]);

    if (!trimmedQuery) return;

    setQuerySearching(true);
    try {
      const payload = await createEmbeddings(trimmedQuery);
      const queryEmbedding = payload.embeddings[0];
      const matches = await retrieveTopQueryMatches(queryEmbedding, 5);
      setQueryResults(matches);

      const answer = await askLLMForQueryAnswer({
        question: trimmedQuery,
        sources: buildQueryAnswerSources(matches)
      });

      setQueryAnswer(answer.answer);
      setQuerySourceItemIds(matches.length ? answer.citedItemIds : []);
    } catch (error) {
      setQueryError(error.message || "Semantic search failed.");
    } finally {
      setQuerySearching(false);
    }
  }

  async function saveFolder(event) {
    event.preventDefault();
    setFolderError("");

    const trimmedName = folderName.trim();
    if (!trimmedName) {
      setFolderError("Folder name is required.");
      return;
    }

    const duplicate = data.folders.find((folder) => folder.name.toLowerCase() === trimmedName.toLowerCase());
    if (duplicate) {
      setFolderError("A folder with that name already exists.");
      return;
    }

    const now = timestamp();
    const folder = {
      id: createId("folder"),
      name: trimmedName,
      description: folderDescription.trim(),
      created_at: now,
      updated_at: now
    };

    try {
      const liveDb = await ensureDb();
      await putRecord(liveDb, "folders", folder);
      try {
        await syncPgvector({ folders: [folder] });
        setVectorStatus("pgvector synced folder.");
        setVectorError("");
      } catch (error) {
        setVectorStatus("");
        setVectorError(`pgvector sync skipped: ${error.message}`);
      }
      setSelectedFolderId(folder.id);
      setFolderName("");
      setFolderDescription("");
      setFolderFormOpen(false);
      await refresh(liveDb);
    } catch (error) {
      setFolderError(error.message || "Folder could not be saved.");
    }
  }

  async function addItem(event) {
    event.preventDefault();
    setItemError("");
    setItemStatus("");

    const title = (itemTitle || itemFile?.name || "Untitled note").trim();
    const content = itemContent.trim();

    if (!title) {
      setItemError("Item title is required.");
      return;
    }

    if (itemType === "file" && !itemFile) {
      setItemError("Choose a local file.");
      return;
    }

    if (itemType === "note" && !content) {
      setItemError("Note content is required.");
      return;
    }

    setItemSaving(true);
    try {
      debugUpload("upload: start", {
        type: itemType,
        title,
        file_name: itemFile?.name || "",
        file_size: itemFile?.size || 0
      });

      setItemStatus(itemType === "file" ? "Parsing with Docling..." : "Preparing note...");
      const parsedDocument = itemType === "file" ? await parseFileWithDocling(itemFile) : parseNoteContent(content);
      debugUpload("upload: parsed", {
        type: itemType,
        title,
        parser: parsedDocument.parser || "unknown",
        source_type: parsedDocument.source_type || itemType,
        chunk_count: parsedDocument.chunks?.length || 0,
        text_chars: String(parsedDocument.text || content || "").length
      });

      const now = timestamp();
      const itemId = createId("item");
      const localFileId = itemType === "file" ? createId("local_file") : "";
      const rawText = parsedDocument.text || content;
      const sourceType = parsedDocument.source_type || itemType;
      const sourceMetadata = {
        ...(parsedDocument.metadata || {}),
        file_name: itemFile?.name || "",
        file_size: itemFile?.size || 0,
        mime_type: itemFile?.type || "",
        parser: parsedDocument.parser || "unknown",
        parsed_at: now,
        title,
        url: ""
      };
      const item = {
        id: itemId,
        source_id: itemId,
        source_type: sourceType,
        type: itemType,
        title,
        source_path: itemFile ? `indexeddb://${itemFile.name}` : "",
        raw_text: rawText,
        content_text: rawText,
        parsed_markdown: parsedDocument.markdown || rawText,
        metadata: sourceMetadata,
        parser: parsedDocument.parser || "unknown",
        parser_source_type: sourceType,
        parsed_at: now,
        parsed_chunk_count: parsedDocument.chunks?.length || 0,
        local_file_id: localFileId,
        file_name: itemFile?.name || "",
        file_size: itemFile?.size || 0,
        mime_type: itemFile?.type || "",
        status: "stored",
        created_at: now,
        updated_at: now
      };

      setItemStatus("Saving parsed chunks...");
      const liveDb = await ensureDb();
      const parsedItem = {
        ...item,
        status: "parsed",
        staged_for: "embedding",
        updated_at: timestamp()
      };
      await putRecord(liveDb, "items", parsedItem);
      if (itemType === "file") {
        await putRecord(liveDb, "local_files", {
          id: localFileId,
          item_id: parsedItem.id,
          file_name: itemFile.name,
          mime_type: itemFile.type || "application/octet-stream",
          size: itemFile.size,
          blob: itemFile,
          created_at: now
        });
      }
      const chunkRecords = await saveDocumentChunks(liveDb, parsedItem, parsedDocument.chunks || [], now);
      debugUpload("upload: chunks saved", {
        item_id: parsedItem.id,
        chunks: chunkRecords.length
      });
      const embeddedChunksForItem = await embedChunkRecords(liveDb, chunkRecords, setItemStatus);
      debugUpload("upload: chunks embedded", {
        item_id: parsedItem.id,
        embedded: embeddedChunksForItem.filter((chunk) => chunk.embedding_status === "embedded").length
      });
      const embeddedItem = await markItemEmbedded(liveDb, parsedItem, embeddedChunksForItem);
      debugUpload("upload: item embedded", {
        item_id: embeddedItem.id,
        embedded_chunk_count: embeddedItem.embedded_chunk_count
      });
      setVectorError("");
      try {
        await syncPgvector({
          source: pgvectorSourceForItem(embeddedItem),
          chunks: embeddedChunksForItem
        });
        setVectorStatus("pgvector synced embedded chunks.");
      } catch (error) {
        setVectorStatus("");
        setVectorError(`pgvector sync skipped: ${error.message}`);
      }

      setItemStatus("Deciding folder...");
      debugUpload("upload: folder decision start", { item_id: embeddedItem.id, threshold: FOLDER_MATCH_THRESHOLD });
      await decideFolderForEmbeddedItem(liveDb, embeddedItem, embeddedChunksForItem);
      debugUpload("upload: done", { item_id: embeddedItem.id });
      setItemTitle("");
      setItemContent("");
      setItemFile(null);
      setItemStatus("");
      await refresh(liveDb);
    } catch (error) {
      setItemError(error.message || "Item could not be saved locally.");
      setItemStatus("");
    } finally {
      setItemSaving(false);
    }
  }

  async function saveDocumentChunks(liveDb, item, chunks, now) {
    const records = chunks.map((chunk) => ({
      id: `${item.id}:chunk:${chunk.index}`,
      source_id: item.source_id,
      source_type: item.source_type,
      item_id: item.id,
      chunk_index: chunk.index,
      heading: chunk.heading || "Document",
      markdown: chunk.markdown || chunk.text || "",
      text: chunk.text || chunk.markdown || "",
      char_count: chunk.char_count || (chunk.text || chunk.markdown || "").length,
      parser: item.parser,
      metadata: {
        source_type: item.source_type,
        parser: item.parser,
        heading: chunk.heading || "Document"
      },
      embedding_status: "pending",
      created_at: now,
      updated_at: now
    }));

    await Promise.all(
      records.map((record) => putRecord(liveDb, "document_chunks", record))
    );
    return records;
  }

  async function createFolderRecord(name, description, providedDb) {
    const liveDb = providedDb || (await ensureDb());
    const now = timestamp();
    const folder = {
      id: createId("folder"),
      name,
      description,
      created_at: now,
      updated_at: now
    };
    await putRecord(liveDb, "folders", folder);
    return folder;
  }

  async function createFolderFromSuggestion(suggestion) {
    const name = suggestion.suggested_folder_name || "Unsorted";
    const existingFolder = data.folders.find((folder) => folder.name.toLowerCase() === name.toLowerCase());
    const folder = existingFolder || (await createFolderRecord(name, "Created from a local prototype suggestion."));
    await assignItem(suggestion.item_id, folder.id, suggestion, "suggested");
  }

  async function acceptSuggestion(suggestion) {
    if (suggestion.folder_id) {
      await assignItem(suggestion.item_id, suggestion.folder_id, suggestion, "suggested");
      return;
    }

    await createFolderFromSuggestion(suggestion);
  }

  async function assignItem(itemId, folderId, suggestion, assignmentType) {
    const liveDb = await ensureDb();
    const item = itemById(itemId);
    if (!item) return;

    const now = timestamp();
    await putRecord(liveDb, "folder_items", {
      id: `${folderId}:${itemId}`,
      folder_id: folderId,
      source_id: item.source_id || item.id,
      item_id: itemId,
      assignment_type: assignmentType,
      created_at: now
    });
    await putRecord(liveDb, "items", { ...item, status: "assigned", updated_at: now });

    if (suggestion) {
      await putRecord(liveDb, "folder_suggestions", {
        ...suggestion,
        status: "accepted",
        updated_at: now
      });
    }

    setSelectedFolderId(folderId);
    await refresh(liveDb);
  }

  async function dismissSuggestion(suggestion) {
    const liveDb = await ensureDb();
    const item = itemById(suggestion.item_id);
    if (!item) return;

    const now = timestamp();
    await putRecord(liveDb, "folder_suggestions", { ...suggestion, status: "dismissed", updated_at: now });
    await putRecord(liveDb, "items", { ...item, status: "needs_review", updated_at: now });
    await refresh(liveDb);
  }

  async function removeItem(itemId) {
    const liveDb = await ensureDb();
    const fileCopies = data.localFiles.filter((file) => file.item_id === itemId);
    const itemSuggestions = data.suggestions.filter((suggestion) => suggestion.item_id === itemId);
    const itemRelations = data.folderItems.filter((row) => row.item_id === itemId);
    const itemChunks = data.documentChunks.filter((chunk) => chunk.item_id === itemId);

    await Promise.all([
      ...fileCopies.map((file) => deleteRecord(liveDb, "local_files", file.id)),
      ...itemSuggestions.map((suggestion) => deleteRecord(liveDb, "folder_suggestions", suggestion.id)),
      ...itemRelations.map((row) => deleteRecord(liveDb, "folder_items", row.id)),
      ...itemChunks.map((chunk) => deleteRecord(liveDb, "document_chunks", chunk.id)),
      deleteRecord(liveDb, "items", itemId)
    ]);

    await refresh(liveDb);
  }

  async function removeFolder(folderId) {
    const liveDb = await ensureDb();
    const folder = data.folders.find((entry) => entry.id === folderId);
    if (!folder) return;

    const folderRelations = data.folderItems.filter((row) => row.folder_id === folderId);
    const itemIds = [...new Set(folderRelations.map((row) => row.item_id))];
    const itemIdsOnlyInThisFolder = itemIds.filter((itemId) =>
      data.folderItems.every((row) => row.item_id !== itemId || row.folder_id === folderId)
    );
    const shouldRemove = window.confirm(
      `Remove "${folder.name}" and ${itemIdsOnlyInThisFolder.length} stored file${itemIdsOnlyInThisFolder.length === 1 ? "" : "s"} only kept there?`
    );
    if (!shouldRemove) return;

    const folderSuggestions = data.suggestions.filter(
      (suggestion) => suggestion.folder_id === folderId || itemIdsOnlyInThisFolder.includes(suggestion.item_id)
    );
    const fileCopies = data.localFiles.filter((file) => itemIdsOnlyInThisFolder.includes(file.item_id));
    const itemChunks = data.documentChunks.filter((chunk) => itemIdsOnlyInThisFolder.includes(chunk.item_id));

    await Promise.all([
      ...fileCopies.map((file) => deleteRecord(liveDb, "local_files", file.id)),
      ...itemChunks.map((chunk) => deleteRecord(liveDb, "document_chunks", chunk.id)),
      ...folderSuggestions.map((suggestion) => deleteRecord(liveDb, "folder_suggestions", suggestion.id)),
      ...folderRelations.map((row) => deleteRecord(liveDb, "folder_items", row.id)),
      ...itemIdsOnlyInThisFolder.map((itemId) => deleteRecord(liveDb, "items", itemId)),
      deleteRecord(liveDb, "folders", folderId)
    ]);

    setSelectedFolderId(null);
    await refresh(liveDb);
  }

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">Local-first prototype</p>
          <h1>AI Organizer</h1>
        </div>
        <nav className="view-switcher" aria-label="Dashboard views">
          <button
            className={activeView === "ask" ? "active" : ""}
            type="button"
            onClick={() => setActiveView("ask")}
          >
            Ask
          </button>
          <button
            className={activeView === "add" ? "active" : ""}
            type="button"
            onClick={() => setActiveView("add")}
          >
            Add
          </button>
          <button
            className={activeView === "manage" ? "active" : ""}
            type="button"
            onClick={() => setActiveView("manage")}
          >
            Manage
          </button>
        </nav>
      </header>
      {storageError ? <p className="storage-error">{storageError}</p> : null}

      {activeView === "ask" ? (
        <section className="query-view" aria-label="Query">
          <form
            className="query-bar"
            onSubmit={searchEmbeddedChunks}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M10.8 4.2a6.6 6.6 0 1 1 0 13.2 6.6 6.6 0 0 1 0-13.2Zm0 2a4.6 4.6 0 1 0 0 9.2 4.6 4.6 0 0 0 0-9.2Zm5.1 9.7 4.1 4.1-1.4 1.4-4.1-4.1 1.4-1.4Z" />
            </svg>
            <input
              aria-label="Search stored knowledge"
              placeholder="Ask about your stored documents"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button aria-label="Search" disabled={querySearching} type="submit">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M10.8 4.2a6.6 6.6 0 1 1 0 13.2 6.6 6.6 0 0 1 0-13.2Zm0 2a4.6 4.6 0 1 0 0 9.2 4.6 4.6 0 0 0 0-9.2Zm5.1 9.7 4.1 4.1-1.4 1.4-4.1-4.1 1.4-1.4Z" />
              </svg>
            </button>
          </form>
          {queryError ? <p className="storage-error">{queryError}</p> : null}
          {hasQuery ? (
            <section className="query-result" aria-label="Query result">
              <p className="eyebrow">Answer</p>
              <p>{querySearching ? "Retrieving the top files and drafting an answer..." : `Answer for "${submittedQuery}"`}</p>
              <div className="answer-block">
                {queryAnswer ? (
                  <>
                    <p className="answer-copy">{queryAnswer}</p>
                    {querySourceResults.length ? (
                      <p className="muted-copy">
                        Sources:{" "}
                        {querySourceResults.map(({ item }, index) => (
                          <span key={item.id}>
                            {index > 0 ? ", " : ""}
                            <QuerySourceLink
                              fileCopy={fileCopyForItem(item)}
                              title={item.title}
                            />
                          </span>
                        ))}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="muted-copy">
                    {querySearching ? "Building an answer from the most relevant files..." : "No answer available yet."}
                  </p>
                )}
              </div>
              {querySearching || queryResults.length ? (
                <div className="reference-block">
                  <h2>Relevant files</h2>
                  {queryResults.length ? (
                    <div className="reference-list">
                      {queryResults.map(({ chunk, item, folderName }) => (
                        <article className="reference-card" key={chunk.id}>
                          <div>
                            <h3>{item.title}</h3>
                            <p>{folderName || folderNameForItem(item.id)}</p>
                            <p>{excerptForQuery(chunk.text, submittedQuery, 140)}</p>
                          </div>
                          <LocalFilePreview fileCopy={fileCopyForItem(item)} />
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="muted-copy">Searching relevant files...</p>
                  )}
                </div>
              ) : null}
            </section>
          ) : null}
        </section>
      ) : null}

      {activeView === "add" ? (
        <section className="add-view" aria-label="Add files and notes">
          <section className="panel add-panel">
            <div>
              <p className="eyebrow">Local collection</p>
              <h2>Add a File or Note</h2>
            </div>
            <form onSubmit={addItem}>
              <fieldset className="segmented-control">
                <legend>Type</legend>
                <label>
                  <input
                    checked={itemType === "file"}
                    name="itemType"
                    onChange={() => setItemType("file")}
                    type="radio"
                  />
                  <span>File</span>
                </label>
                <label>
                  <input
                    checked={itemType === "note"}
                    name="itemType"
                    onChange={() => setItemType("note")}
                    type="radio"
                  />
                  <span>Note</span>
                </label>
              </fieldset>

              <label>
                <span>Title</span>
                <input
                  placeholder="Topic_Date.pdf"
                  value={itemTitle}
                  onChange={(event) => setItemTitle(event.target.value)}
                />
              </label>

              {itemType === "file" ? (
                <label>
                  <span>Local file</span>
                  <input
                    accept=".pdf,.docx,.pptx,.md,.markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/markdown,text/x-markdown"
                    type="file"
                    onChange={(event) => {
                      const file = event.target.files?.[0] || null;
                      setItemFile(file);
                      if (file && !itemTitle) setItemTitle(file.name);
                    }}
                  />
                </label>
              ) : (
                <label>
                  <span>Note</span>
                  <textarea
                    rows="8"
                    placeholder="Paste text here"
                    value={itemContent}
                    onChange={(event) => setItemContent(event.target.value)}
                  />
                </label>
              )}

              <button disabled={!storageReady || itemSaving} type="submit">
                {itemSaving ? "Processing..." : "Add Item"}
              </button>
              {itemStatus ? <p className="form-status">{itemStatus}</p> : null}
              {itemError ? <p className="form-error">{itemError}</p> : null}
            </form>
          </section>
        </section>
      ) : null}

      {activeView === "manage" ? (
        <section className="storage-view" aria-label="Storage">
          <div className="storage-stats">
            <StatCard label="stored" value={data.items.length} />
            <StatCard label="folders" value={data.folders.length} />
            <StatCard label="pending vectors" value={pendingEmbeddingChunks.length} />
            <StatCard label="pending decisions" value={decisionCandidateItems.length} />
          </div>

          <div className="storage-grid">
            <aside className="panel sidebar-panel">
              <div className="panel-heading">
                <h2>Folders</h2>
                <button className="icon-button" type="button" onClick={() => setFolderFormOpen(!folderFormOpen)}>
                  +
                </button>
              </div>

              {folderFormOpen ? (
                <form className="folder-form" onSubmit={saveFolder}>
                  <label>
                    <span>Name</span>
                    <input value={folderName} onChange={(event) => setFolderName(event.target.value)} />
                  </label>
                  <label>
                    <span>Description</span>
                    <textarea
                      rows="3"
                      value={folderDescription}
                      onChange={(event) => setFolderDescription(event.target.value)}
                    />
                  </label>
                  <div className="button-row">
                    <button disabled={!storageReady} type="submit">Save</button>
                    <button className="secondary" type="button" onClick={() => setFolderFormOpen(false)}>
                      Cancel
                    </button>
                  </div>
                  {folderError ? <p className="form-error">{folderError}</p> : null}
                </form>
              ) : null}

              <div className="folder-list">
                <button
                  className={`folder-button ${!selectedFolderId ? "active" : ""}`}
                  type="button"
                  onClick={() => setSelectedFolderId(null)}
                >
                  <strong>Review Inbox</strong>
                  <span>{pendingSuggestions.length}</span>
                </button>
                {data.folders.map((folder) => (
                  <button
                    className={`folder-button ${selectedFolderId === folder.id ? "active" : ""}`}
                    key={folder.id}
                    type="button"
                    onClick={() => setSelectedFolderId(folder.id)}
                  >
                    <strong>{folder.name}</strong>
                    <span>{folderCount(folder.id)}</span>
                  </button>
                ))}
              </div>
            </aside>

            <section className="panel detail-panel">
              <div className="detail-heading">
                <div>
                  <p className="eyebrow">
                    {selectedFolder ? `${selectedFolderItems.length} items` : "Pending suggestions"}
                  </p>
                  <h2>{selectedFolder ? selectedFolder.name : "Review Inbox"}</h2>
                </div>
                {selectedFolder ? (
                  <button className="danger-button" type="button" onClick={() => removeFolder(selectedFolder.id)}>
                    Remove folder
                  </button>
                ) : null}
              </div>
              {selectedFolder?.description ? <p className="folder-description">{selectedFolder.description}</p> : null}

              <div className="item-stack">
                {selectedFolder ? (
                  selectedFolderItems.length ? (
                    selectedFolderItems.map((item) => (
                      <ItemCard
                        chunkCount={chunkCountForItem(item.id)}
                        embeddedChunkCount={embeddedChunkCountForItem(item.id)}
                        fileCopy={fileCopyForItem(item)}
                        item={item}
                        key={item.id}
                        onRemove={removeItem}
                      />
                    ))
                  ) : (
                    <EmptyState />
                  )
                ) : pendingSuggestions.length ? (
                  pendingSuggestions.map((suggestion) => {
                    const item = itemById(suggestion.item_id);
                    return (
                      <ReviewCard
                        assignItem={assignItem}
                        dismissSuggestion={dismissSuggestion}
                        fileCopy={fileCopyForItem(item)}
                        folders={data.folders}
                        folderById={folderById}
                        item={item}
                        chunkCount={item ? chunkCountForItem(item.id) : 0}
                        key={suggestion.id}
                        onAccept={acceptSuggestion}
                        onCreate={createFolderFromSuggestion}
                        onRemove={removeItem}
                        suggestion={suggestion}
                      />
                    );
                  })
                ) : (
                  <EmptyState />
                )}
              </div>
            </section>

            <aside className="right-column">
              <section className="panel tool-panel">
                <div className="panel-heading">
                  <h2>Embeddings</h2>
                  <button
                    className="secondary compact"
                    disabled={!storageReady || embeddingSaving || !pendingEmbeddingChunks.length}
                    type="button"
                    onClick={embedPendingChunks}
                  >
                    Embed
                  </button>
                </div>
                <div className="compact-review">
                  <p>{embeddedChunks.length} embedded chunks</p>
                  <p>{pendingEmbeddingChunks.length} pending chunks</p>
                  <p>{EMBEDDING_MODEL}</p>
                </div>
                {embeddingStatus ? <p className="form-status">{embeddingStatus}</p> : null}
                {embeddingError ? <p className="form-error">{embeddingError}</p> : null}
                {vectorStatus ? <p className="form-status">{vectorStatus}</p> : null}
                {vectorError ? <p className="form-error">{vectorError}</p> : null}
              </section>
              <section className="panel tool-panel">
                <div className="panel-heading">
                  <h2>Folder Decisions</h2>
                  <button
                    className="secondary compact"
                    disabled={!storageReady || decisionSaving || !decisionCandidateItems.length}
                    type="button"
                    onClick={decideFoldersForEmbeddedItems}
                  >
                    Decide
                  </button>
                </div>
                <div className="compact-review">
                  <p>{decisionCandidateItems.length} embedded items waiting</p>
                  <p>{realFolders.length} candidate folders</p>
                  <p>{Math.round(FOLDER_MATCH_THRESHOLD * 100)}% similarity threshold</p>
                </div>
                {decisionStatus ? <p className="form-status">{decisionStatus}</p> : null}
                {decisionError ? <p className="form-error">{decisionError}</p> : null}
              </section>
            </aside>
          </div>
        </section>
      ) : null}
    </main>
  );
}

function StatCard({ label, value }) {
  return (
    <div className="stat-card">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <p>No items yet.</p>
    </div>
  );
}

function ItemCard({ chunkCount, embeddedChunkCount, fileCopy, item, onRemove }) {
  return (
    <article className="item-card">
      <header>
        <div>
          <h3>{item.title}</h3>
          <p>
            {fileCopy
              ? `Local copy: ${fileCopy.file_name} · ${formatBytes(fileCopy.size)}`
              : item.content_text.slice(0, 160)}
          </p>
        </div>
        <span>{item.source_type || item.type}</span>
      </header>
      <div className="meta-row">
        <span>{item.status}</span>
        <span>{chunkCount || item.parsed_chunk_count || 0} chunks</span>
        <span>{embeddedChunkCount || item.embedded_chunk_count || 0} vectors</span>
        <span>{item.parser || "parser"}</span>
        <span>{formatDate(item.created_at)}</span>
      </div>
      <div className="item-actions">
        <LocalFilePreview fileCopy={fileCopy} />
        {onRemove ? (
          <button className="danger-button" type="button" onClick={() => onRemove(item.id)}>
            Remove file
          </button>
        ) : null}
      </div>
    </article>
  );
}

function LocalFilePreview({ className = "", fileCopy, label = "Open preview" }) {
  const [downloadUrl, setDownloadUrl] = useState("");

  useEffect(() => {
    if (!fileCopy?.blob) {
      setDownloadUrl("");
      return undefined;
    }

    const url = URL.createObjectURL(fileCopy.blob);
    setDownloadUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [fileCopy]);

  if (!downloadUrl) return null;

  return (
    <a className={["preview-link", className].filter(Boolean).join(" ")} href={downloadUrl} rel="noreferrer" target="_blank">
      {label}
    </a>
  );
}

function QuerySourceLink({ fileCopy, title }) {
  const fallbackTitle = title || "Untitled";
  const previewLink = (
    <LocalFilePreview
      className="source-file-link"
      fileCopy={fileCopy}
      label={fallbackTitle}
    />
  );

  return previewLink || <span className="source-file-name">{fallbackTitle}</span>;
}

function ReviewCard({
  assignItem,
  chunkCount,
  dismissSuggestion,
  fileCopy,
  folders,
  folderById,
  item,
  onAccept,
  onCreate,
  onRemove,
  suggestion
}) {
  const [selectedFolderId, setSelectedFolderId] = useState("");

  if (!item) return null;

  const suggestedFolderName = suggestion.folder_id
    ? folderById(suggestion.folder_id)?.name || "Unknown folder"
    : suggestion.suggested_folder_name || "Choose folder";

  return (
    <article className="review-card">
      <header>
        <div>
          <h3>{item.title}</h3>
          <p>{suggestion.reason}</p>
        </div>
        <span>{item.status}</span>
      </header>
      <p>
        Suggested: <strong>{suggestedFolderName}</strong>
      </p>
      <p>
        Parsed into <strong>{chunkCount || item.parsed_chunk_count || 0}</strong> chunks with{" "}
        <strong>{item.parser || "the local parser"}</strong>.
      </p>
      {fileCopy ? (
        <p>
          Local copy: <strong>{fileCopy.file_name}</strong> · {formatBytes(fileCopy.size)}
        </p>
      ) : null}
      <LocalFilePreview fileCopy={fileCopy} />
      <div className="review-actions">
        <button type="button" onClick={() => onAccept(suggestion)}>
          Accept
        </button>
        <select
          aria-label="Choose another folder"
          value={selectedFolderId}
          onChange={(event) => setSelectedFolderId(event.target.value)}
        >
          <option value="">Choose another folder</option>
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </select>
        <button
          className="secondary"
          disabled={!selectedFolderId}
          type="button"
          onClick={() => assignItem(item.id, selectedFolderId, suggestion, "manual")}
        >
          Assign Selected
        </button>
        <button className="secondary" type="button" onClick={() => onCreate(suggestion)}>
          Create New Folder
        </button>
        <button className="secondary" type="button" onClick={() => dismissSuggestion(suggestion)}>
          Dismiss
        </button>
        <button className="danger-button" type="button" onClick={() => onRemove(item.id)}>
          Remove file
        </button>
      </div>
    </article>
  );
}
