"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const DB_NAME = "ai-organizer-prototype";
const DB_VERSION = 2;
const STORE_NAMES = ["folders", "items", "folder_items", "folder_suggestions", "local_files"];

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

function findSuggestionMatch(title) {
  const value = title.toLowerCase();

  if (value.includes("database")) {
    return { folderName: "Databases", reason: 'Filename contains "database".' };
  }

  if (value.includes("machine-learning") || value.includes("machine learning") || /\bml\b/.test(value)) {
    return { folderName: "Machine Learning", reason: "Filename contains a machine learning keyword." };
  }

  if (value.includes("regression")) {
    return { folderName: "Regression", reason: 'Filename contains "regression".' };
  }

  return null;
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
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [data, setData] = useState({
    folders: [],
    items: [],
    folderItems: [],
    suggestions: [],
    localFiles: []
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

    const [folders, items, folderItems, suggestions, localFiles] = await Promise.all(
      STORE_NAMES.map((storeName) => getAll(liveDb, storeName))
    );

    setData({
      folders: folders.sort((a, b) => a.name.localeCompare(b.name)),
      items: items.sort((a, b) => b.created_at.localeCompare(a.created_at)),
      folderItems,
      suggestions: suggestions.sort((a, b) => b.created_at.localeCompare(a.created_at)),
      localFiles
    });
  }

  useEffect(() => {
    let mounted = true;

    async function boot() {
      const nextDb = await ensureDb();
      if (!mounted) return;
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

  const selectedFolder = data.folders.find((folder) => folder.id === selectedFolderId) || null;
  const selectedFolderItems = selectedFolder
    ? data.items.filter((item) =>
      data.folderItems.some((row) => row.folder_id === selectedFolder.id && row.item_id === item.id)
    )
    : [];
  const machineLearningFolder =
    data.folders.find((folder) => folder.name.toLowerCase() === "machine learning") || null;
  const machineLearningReferences = machineLearningFolder
    ? data.items.filter((item) =>
      data.folderItems.some((row) => row.folder_id === machineLearningFolder.id && row.item_id === item.id)
    )
    : [];
  const hasQuery = submittedQuery.trim().length > 0;

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

    const now = timestamp();
    const localFileId = itemType === "file" ? createId("local_file") : "";
    const item = {
      id: createId("item"),
      type: itemType,
      title,
      source_path: itemFile ? `indexeddb://${itemFile.name}` : "",
      content_text: itemType === "note" ? content : `Mock extracted text for ${title}`,
      local_file_id: localFileId,
      file_name: itemFile?.name || "",
      file_size: itemFile?.size || 0,
      mime_type: itemFile?.type || "",
      status: "stored",
      created_at: now,
      updated_at: now
    };

    try {
      const liveDb = await ensureDb();
      await putRecord(liveDb, "items", item);
      if (itemType === "file") {
        await putRecord(liveDb, "local_files", {
          id: localFileId,
          item_id: item.id,
          file_name: itemFile.name,
          mime_type: itemFile.type || "application/octet-stream",
          size: itemFile.size,
          blob: itemFile,
          created_at: now
        });
      }
      await createSuggestion(item);
      setItemTitle("");
      setItemContent("");
      setItemFile(null);
      setSelectedFolderId(null);
      await refresh(liveDb);
    } catch (error) {
      setItemError(error.message || "Item could not be saved locally.");
    }
  }

  async function createSuggestion(item) {
    const liveDb = await ensureDb();
    const match = findSuggestionMatch(item.title);
    const now = timestamp();

    if (!match) {
      await putRecord(liveDb, "folder_suggestions", {
        id: createId("suggestion"),
        item_id: item.id,
        folder_id: "",
        suggested_folder_name: "",
        reason: "No local keyword rule matched.",
        status: "pending",
        created_at: now,
        updated_at: now
      });
      await putRecord(liveDb, "items", { ...item, status: "needs_review", updated_at: now });
      return;
    }

    const existingFolder = data.folders.find(
      (folder) => folder.name.toLowerCase() === match.folderName.toLowerCase()
    );

    await putRecord(liveDb, "folder_suggestions", {
      id: createId("suggestion"),
      item_id: item.id,
      folder_id: existingFolder?.id || "",
      suggested_folder_name: existingFolder ? "" : match.folderName,
      reason: match.reason,
      status: "pending",
      created_at: now,
      updated_at: now
    });
  }

  async function createFolderRecord(name, description) {
    const liveDb = await ensureDb();
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

    await Promise.all([
      ...fileCopies.map((file) => deleteRecord(liveDb, "local_files", file.id)),
      ...itemSuggestions.map((suggestion) => deleteRecord(liveDb, "folder_suggestions", suggestion.id)),
      ...itemRelations.map((row) => deleteRecord(liveDb, "folder_items", row.id)),
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
    const shouldRemove = window.confirm(
      `Remove "${folder.name}" and ${itemIds.length} stored file${itemIds.length === 1 ? "" : "s"}?`
    );
    if (!shouldRemove) return;

    const folderSuggestions = data.suggestions.filter(
      (suggestion) => suggestion.folder_id === folderId || itemIds.includes(suggestion.item_id)
    );
    const itemRelations = data.folderItems.filter((row) => itemIds.includes(row.item_id));
    const fileCopies = data.localFiles.filter((file) => itemIds.includes(file.item_id));

    // Future production flow: only remove files solely associated with this folder,
    // then ask the user to confirm if that list of unique files will be removed.
    await Promise.all([
      ...fileCopies.map((file) => deleteRecord(liveDb, "local_files", file.id)),
      ...folderSuggestions.map((suggestion) => deleteRecord(liveDb, "folder_suggestions", suggestion.id)),
      ...itemRelations.map((row) => deleteRecord(liveDb, "folder_items", row.id)),
      ...itemIds.map((itemId) => deleteRecord(liveDb, "items", itemId)),
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
            onSubmit={(event) => {
              event.preventDefault();
              setSubmittedQuery(query.trim());
            }}
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
            <button aria-label="Search" type="submit">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M10.8 4.2a6.6 6.6 0 1 1 0 13.2 6.6 6.6 0 0 1 0-13.2Zm0 2a4.6 4.6 0 1 0 0 9.2 4.6 4.6 0 0 0 0-9.2Zm5.1 9.7 4.1 4.1-1.4 1.4-4.1-4.1 1.4-1.4Z" />
              </svg>
            </button>
          </form>
          {hasQuery ? (
            <section className="query-result" aria-label="Query result">
              <p className="eyebrow">Prototype answer</p>
              <p>
                Gradient descent is an optimization algorithm that iteratively
                adjusts parameters in the direction of the negative gradient to
                minimize a function (like a loss function in machine learning).
              </p>
              <div className="reference-block">
                <h2>References</h2>
                {machineLearningReferences.length ? (
                  <div className="reference-list">
                    {machineLearningReferences.map((item) => (
                      <article className="reference-card" key={item.id}>
                        <div>
                          <h3>{item.title}</h3>
                          <p>{machineLearningFolder.name}</p>
                        </div>
                        <LocalFilePreview fileCopy={fileCopyForItem(item)} />
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="muted-copy">No files are assigned to the Machine Learning folder yet.</p>
                )}
              </div>
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
                  placeholder="machine-learning-slides.pdf"
                  value={itemTitle}
                  onChange={(event) => setItemTitle(event.target.value)}
                />
              </label>

              {itemType === "file" ? (
                <label>
                  <span>Local file</span>
                  <input
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

              <button disabled={!storageReady} type="submit">Add Item</button>
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
            <StatCard label="review" value={pendingSuggestions.length} />
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
                      <ItemCard fileCopy={fileCopyForItem(item)} item={item} key={item.id} onRemove={removeItem} />
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
                  <h2>Review</h2>
                  <button className="secondary compact" type="button" onClick={() => setSelectedFolderId(null)}>
                    Open
                  </button>
                </div>
                <div className="compact-review">
                  {pendingSuggestions.length ? (
                    pendingSuggestions.slice(0, 3).map((suggestion) => {
                      const item = itemById(suggestion.item_id);
                      return item ? <p key={suggestion.id}>{item.title}</p> : null;
                    })
                  ) : (
                    <p>No items waiting.</p>
                  )}
                </div>
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

function ItemCard({ fileCopy, item, onRemove }) {
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
        <span>{item.type}</span>
      </header>
      <div className="meta-row">
        <span>{item.status}</span>
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

function LocalFilePreview({ fileCopy }) {
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
    <a className="preview-link" href={downloadUrl} rel="noreferrer" target="_blank">
      Open preview
    </a>
  );
}

function ReviewCard({
  assignItem,
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
