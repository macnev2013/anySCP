import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { Search, Plus, FolderPlus, ArrowLeft, Code } from "lucide-react";
import { useSnippetsStore } from "../../stores/snippets-store";
import { useSessionStore } from "../../stores/session-store";
import { useTabStore } from "../../stores/tab-store";
import type { Snippet } from "../../types";
import { extractVariables } from "../../utils/snippet-resolve";
import { SnippetCard } from "./SnippetCard";
import { SnippetFolderCard } from "./SnippetFolderCard";
import { SnippetEditModal } from "./SnippetEditModal";
import { SnippetFolderModal } from "./SnippetFolderModal";
import { VariableDialog } from "./VariableDialog";

// ─── Component ────────────────────────────────────────────────────────────────

export function SnippetsPage() {
  const {
    snippets,
    folders,
    searchResults,
    searchQuery,
    loading,
    loadSnippets,
    loadFolders,
    saveSnippet,
    deleteSnippet,
    saveFolder,
    deleteFolder,
    search,
    clearSearch,
  } = useSnippetsStore();

  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const activateTerminal = useTabStore((s) => s.activateRecentTabOfType);

  const [query, setQuery] = useState("");
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);

  // Modal state
  const [editingSnippet, setEditingSnippet] = useState<Snippet | null | "__new__">(null);
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [executingSnippet, setExecutingSnippet] = useState<Snippet | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load data on mount
  useEffect(() => {
    void loadSnippets(null);
    void loadFolders();
  }, [loadSnippets, loadFolders]);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim()) {
      debounceRef.current = setTimeout(() => {
        void search(query);
      }, 200);
    } else {
      clearSearch();
    }
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, search, clearSearch]);

  // ─── Derived data ────────────────────────────────────────────────────────────

  const snippetCountByFolder = useMemo<Record<string, number>>(() => {
    const counts: Record<string, number> = {};
    for (const snippet of snippets) {
      if (snippet.folder_id) {
        counts[snippet.folder_id] = (counts[snippet.folder_id] ?? 0) + 1;
      }
    }
    return counts;
  }, [snippets]);

  const displayedSnippets = useMemo<Snippet[]>(() => {
    if (searchQuery.trim()) {
      return searchResults.map((r) => r.snippet);
    }
    let result = snippets;
    if (selectedFolderId !== null) {
      result = result.filter((s) => s.folder_id === selectedFolderId);
    }
    return result;
  }, [snippets, searchResults, searchQuery, selectedFolderId]);

  const activeFolder = selectedFolderId
    ? folders.find((f) => f.id === selectedFolderId)
    : null;

  // ─── Execute handler ─────────────────────────────────────────────────────────

  const handleExecute = useCallback(
    async (snippet: Snippet) => {
      const vars = extractVariables(snippet.command);
      const needsDialog = vars.length > 0;

      if (needsDialog) {
        setExecutingSnippet(snippet);
      } else {
        await runCommand(snippet.command, snippet.id);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSessionId],
  );

  const runCommand = async (command: string, snippetId: string) => {
    if (!activeSessionId) {
      activateTerminal("terminal");
      return;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("snippet_execute", {
        sessionId: activeSessionId,
        resolvedCommand: command,
        snippetId,
      });
      await loadSnippets(null);
    } catch {
      // Non-fatal — terminal output will show any errors
    }
  };

  const handleVariableExecute = useCallback(
    async (resolvedCommand: string) => {
      if (!executingSnippet) return;
      setExecutingSnippet(null);
      await runCommand(resolvedCommand, executingSnippet.id);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [executingSnippet, activeSessionId],
  );

  // ─── CRUD handlers ───────────────────────────────────────────────────────────

  const handleSaveSnippet = useCallback(
    async (snippet: Snippet) => {
      await saveSnippet(snippet);
      setEditingSnippet(null);
    },
    [saveSnippet],
  );

  const handleSaveAndExecute = useCallback(
    async (snippet: Snippet) => {
      await saveSnippet(snippet);
      setEditingSnippet(null);
      await handleExecute(snippet);
    },
    [saveSnippet, handleExecute],
  );

  const handleDeleteSnippet = useCallback(
    async (id: string) => {
      await deleteSnippet(id);
    },
    [deleteSnippet],
  );

  const handleDuplicate = useCallback(
    async (snippet: Snippet) => {
      const now = new Date().toISOString();
      const copy: Snippet = {
        ...snippet,
        id: crypto.randomUUID(),
        name: `${snippet.name} (copy)`,
        use_count: 0,
        last_used_at: null,
        created_at: now,
        updated_at: now,
      };
      await saveSnippet(copy);
    },
    [saveSnippet],
  );

  const handleCreateFolder = useCallback(
    async (data: { name: string; color: string }) => {
      const now = new Date().toISOString();
      await saveFolder({
        id: crypto.randomUUID(),
        name: data.name,
        parent_id: null,
        color: data.color,
        icon: null,
        sort_order: folders.length,
        created_at: now,
        updated_at: now,
      });
      setFolderModalOpen(false);
    },
    [saveFolder, folders.length],
  );

  const handleDeleteFolder = useCallback(
    async (id: string) => {
      await deleteFolder(id);
      if (selectedFolderId === id) setSelectedFolderId(null);
    },
    [deleteFolder, selectedFolderId],
  );

  // ─── Keyboard shortcut: focus search ─────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // ─── Render ──────────────────────────────────────────────────────────────────

  const editModalSnippet =
    editingSnippet === "__new__"
      ? null
      : (editingSnippet as Snippet | null);

  return (
    <>
      <div className="flex flex-col h-full overflow-y-auto bg-bg-base">
        <div className="max-w-4xl w-full mx-auto px-8 py-8 flex flex-col gap-8">

          {/* Page title */}
          <div>
            <h1 className="text-[length:var(--text-lg)] font-semibold text-text-primary">Snippets</h1>
            <p className="text-[length:var(--text-xs)] text-text-muted mt-1">Save frequently used commands, organize them into folders, and execute with one click</p>
          </div>

          {/* Search bar */}
          <div className="relative">
            <Search
              size={15}
              strokeWidth={2}
              className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
              aria-hidden="true"
            />
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQuery("");
              }}
              placeholder="Search snippets... (Cmd+F)"
              aria-label="Search snippets"
              className={[
                "w-full pl-10 pr-4 py-2.5 rounded-xl text-[length:var(--text-sm)]",
                "bg-bg-surface border border-border text-text-primary placeholder:text-text-muted",
                "outline-none transition-[border-color,box-shadow] duration-[var(--duration-fast)]",
                "focus:border-border-focus focus:ring-2 focus:ring-ring",
              ].join(" ")}
            />
          </div>

          {/* Action buttons */}
          <div className="flex gap-2">
            <button
              onClick={() => setEditingSnippet("__new__")}
              className={[
                "flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium uppercase tracking-wide",
                "bg-bg-surface border border-border text-text-secondary",
                "hover:border-border-focus hover:text-text-primary hover:bg-bg-overlay",
                "transition-all duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              ].join(" ")}
              title="New Snippet (Cmd+N)"
            >
              <Plus size={13} strokeWidth={2.2} aria-hidden="true" />
              New Snippet
            </button>

            <button
              onClick={() => setFolderModalOpen(true)}
              className={[
                "flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium uppercase tracking-wide",
                "bg-bg-surface border border-border text-text-secondary",
                "hover:border-border-focus hover:text-text-primary hover:bg-bg-overlay",
                "transition-all duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              ].join(" ")}
              title="New Folder"
            >
              <FolderPlus size={13} strokeWidth={2} aria-hidden="true" />
              New Folder
            </button>
          </div>

          {/* Folders section */}
          {folders.length > 0 && !searchQuery && (
            <section aria-labelledby="folders-heading">
              <h2
                id="folders-heading"
                className="text-[length:var(--text-xs)] font-semibold uppercase tracking-widest text-text-muted mb-3"
              >
                Folders
              </h2>
              <div className="grid grid-cols-3 gap-2.5">
                {folders.map((folder) => (
                  <SnippetFolderCard
                    key={folder.id}
                    folder={folder}
                    snippetCount={snippetCountByFolder[folder.id] ?? 0}
                    isSelected={selectedFolderId === folder.id}
                    onSelect={(id) =>
                      setSelectedFolderId((prev) => (prev === id ? null : id))
                    }
                    onDelete={(id) => void handleDeleteFolder(id)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Snippets section */}
          <section aria-labelledby="snippets-heading">
            <div className="flex items-center gap-3 mb-3">
              {/* Breadcrumb back button when a folder is selected */}
              {activeFolder && !searchQuery && (
                <button
                  onClick={() => setSelectedFolderId(null)}
                  className={[
                    "flex items-center gap-1.5 text-[length:var(--text-xs)] text-text-muted",
                    "hover:text-text-secondary transition-colors duration-[var(--duration-fast)]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded",
                  ].join(" ")}
                  aria-label="Back to all snippets"
                >
                  <ArrowLeft size={12} strokeWidth={2.2} aria-hidden="true" />
                  All Snippets
                </button>
              )}

              <h2
                id="snippets-heading"
                className="text-[length:var(--text-xs)] font-semibold uppercase tracking-widest text-text-muted"
              >
                {searchQuery
                  ? `Results for "${searchQuery}"`
                  : activeFolder
                    ? activeFolder.name
                    : "Snippets"}
              </h2>

              {loading && (
                <span className="text-[10px] text-text-muted animate-pulse ml-auto">
                  Loading...
                </span>
              )}
            </div>

            {displayedSnippets.length > 0 ? (
              <div className="flex flex-col gap-2">
                {displayedSnippets.map((snippet) => (
                  <SnippetCard
                    key={snippet.id}
                    snippet={snippet}
                    onEdit={(s) => setEditingSnippet(s)}
                    onDelete={(id) => void handleDeleteSnippet(id)}
                    onDuplicate={(s) => void handleDuplicate(s)}
                  />
                ))}
              </div>
            ) : (
              <EmptySnippetsState query={query} hasFolderFilter={selectedFolderId !== null} />
            )}
          </section>
        </div>
      </div>

      {/* Edit / create modal */}
      <SnippetEditModal
        open={editingSnippet !== null}
        initial={editModalSnippet}
        folders={folders}
        onClose={() => setEditingSnippet(null)}
        onSave={(s) => handleSaveSnippet(s)}
        onSaveAndExecute={(s) => handleSaveAndExecute(s)}
      />

      {/* Folder create modal */}
      <SnippetFolderModal
        open={folderModalOpen}
        onClose={() => setFolderModalOpen(false)}
        onSave={(data) => handleCreateFolder(data)}
      />

      {/* Variable fill-in dialog */}
      {executingSnippet && (
        <VariableDialog
          snippet={executingSnippet}
          onExecute={(cmd) => void handleVariableExecute(cmd)}
          onCancel={() => setExecutingSnippet(null)}
        />
      )}
    </>
  );
}

// ─── Empty states ─────────────────────────────────────────────────────────────

interface EmptySnippetsStateProps {
  query: string;
  hasFolderFilter: boolean;
}

function EmptySnippetsState({ query, hasFolderFilter }: EmptySnippetsStateProps) {
  if (query.trim()) {
    return (
      <p className="text-[length:var(--text-sm)] text-text-muted py-10 text-center">
        No snippets match &ldquo;{query}&rdquo;
      </p>
    );
  }

  if (hasFolderFilter) {
    return (
      <p className="text-[length:var(--text-sm)] text-text-muted py-10 text-center">
        No snippets in this folder yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-bg-surface border border-border">
        <Code size={22} strokeWidth={1.5} className="text-text-muted" aria-hidden="true" />
      </div>
      <div>
        <p className="text-[length:var(--text-sm)] font-medium text-text-secondary">
          No snippets yet
        </p>
        <p className="text-[length:var(--text-xs)] text-text-muted mt-1">
          Create reusable commands with{" "}
          <span className="font-mono text-accent">{"{{variables}}"}</span> for one-click execution.
        </p>
      </div>
    </div>
  );
}
