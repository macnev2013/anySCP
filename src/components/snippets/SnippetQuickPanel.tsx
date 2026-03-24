import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Search, X, Play, Pin, PinOff } from "lucide-react";
import type { Snippet } from "../../types";
import { useSnippetsStore } from "../../stores/snippets-store";
import { useSessionStore } from "../../stores/session-store";
import { useUiStore } from "../../stores/ui-store";
import { extractVariables } from "../../utils/snippet-resolve";
import { VariableDialog } from "./VariableDialog";

// ─── Component ────────────────────────────────────────────────────────────────

export function SnippetQuickPanel() {
  const snippetPanelOpen = useUiStore((s) => s.snippetPanelOpen);
  const toggleSnippetPanel = useUiStore((s) => s.toggleSnippetPanel);
  const pinned = useUiStore((s) => s.snippetPanelPinned);
  const togglePinned = useUiStore((s) => s.toggleSnippetPanelPinned);

  const { snippets, loadSnippets } = useSnippetsStore();
  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  const [query, setQuery] = useState("");
  const [executingSnippet, setExecutingSnippet] = useState<Snippet | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load snippets when panel opens
  useEffect(() => {
    if (snippetPanelOpen) {
      void loadSnippets(null);
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [snippetPanelOpen, loadSnippets]);

  // Close on Escape
  useEffect(() => {
    if (!snippetPanelOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !executingSnippet) toggleSnippetPanel();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [snippetPanelOpen, toggleSnippetPanel, executingSnippet]);

  // ─── Filtering ──────────────────────────────────────────────────────────────

  const filtered = useMemo<Snippet[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return snippets;
    return snippets.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.command.toLowerCase().includes(q) ||
        (s.tags && s.tags.toLowerCase().includes(q)),
    );
  }, [snippets, query]);

  const recentlyUsed = useMemo<Snippet[]>(() => {
    return [...snippets]
      .filter((s) => s.last_used_at)
      .sort(
        (a, b) =>
          new Date(b.last_used_at!).getTime() - new Date(a.last_used_at!).getTime(),
      )
      .slice(0, 5);
  }, [snippets]);

  const allSorted = useMemo<Snippet[]>(() => {
    return [...snippets].sort((a, b) => b.use_count - a.use_count);
  }, [snippets]);

  // ─── Execute ────────────────────────────────────────────────────────────────

  const handleExecute = useCallback(
    async (snippet: Snippet) => {
      const vars = extractVariables(snippet.command);
      if (vars.length > 0) {
        setExecutingSnippet(snippet);
        return;
      }
      await runCommand(snippet.command, snippet.id);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSessionId],
  );

  const runCommand = async (command: string, snippetId: string) => {
    if (!activeSessionId) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("snippet_execute", {
        sessionId: activeSessionId,
        resolvedCommand: command,
        snippetId,
      });
      await loadSnippets(null);
      toggleSnippetPanel();
    } catch {
      // Non-fatal
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

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (!snippetPanelOpen) return null;

  const displaySnippets = query.trim() ? filtered : allSorted;

  return (
    <>
      {/* Transparent backdrop — click to close (only when floating) */}
      {!pinned && (
        <div
          className="absolute inset-0 z-20"
          onClick={toggleSnippetPanel}
          aria-hidden="true"
        />
      )}
      <div
        className={[
          "flex flex-col bg-bg-surface border-l border-border",
          pinned
            ? "h-full shrink-0"
            : "absolute top-0 right-0 bottom-0 z-30 shadow-[var(--shadow-lg)] animate-[fadeIn_120ms_var(--ease-expo-out)_both]",
        ].join(" ")}
        style={{ width: 280 }}
        aria-label="Snippet quick panel"
        role="complementary"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <span className="text-[length:var(--text-xs)] font-semibold uppercase tracking-widest text-text-muted">
            Snippets
          </span>
          <div className="flex items-center gap-0.5">
            <button
              onClick={togglePinned}
              title={pinned ? "Unpin panel (float)" : "Pin panel (dock)"}
              aria-label={pinned ? "Unpin snippet panel" : "Pin snippet panel"}
              aria-pressed={pinned}
              className={[
                "flex items-center justify-center w-6 h-6 rounded-md",
                "transition-colors duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                pinned
                  ? "text-accent bg-accent/10 hover:bg-accent/15"
                  : "text-text-muted hover:text-text-primary hover:bg-bg-subtle",
              ].join(" ")}
            >
              {pinned ? (
                <PinOff size={13} strokeWidth={2} aria-hidden="true" />
              ) : (
                <Pin size={13} strokeWidth={2} aria-hidden="true" />
              )}
            </button>
            <button
              onClick={toggleSnippetPanel}
              title="Close panel (Escape)"
              aria-label="Close snippet panel"
              className={[
                "flex items-center justify-center w-6 h-6 rounded-md",
                "text-text-muted hover:text-text-primary hover:bg-bg-subtle",
                "transition-colors duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              ].join(" ")}
            >
              <X size={13} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="px-3 py-2.5 border-b border-border shrink-0">
          <div className="relative">
            <Search
              size={13}
              strokeWidth={2}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
              aria-hidden="true"
            />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (debounceRef.current) clearTimeout(debounceRef.current);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  if (query) {
                    setQuery("");
                    e.stopPropagation();
                  }
                }
              }}
              placeholder="Search snippets..."
              aria-label="Search snippets"
              className={[
                "w-full pl-8 pr-3 py-1.5 rounded-lg text-[length:var(--text-xs)]",
                "bg-bg-base border border-border text-text-primary placeholder:text-text-muted",
                "outline-none focus:border-border-focus focus:ring-2 focus:ring-ring",
                "transition-[border-color,box-shadow] duration-[var(--duration-fast)]",
              ].join(" ")}
            />
          </div>
        </div>

        {/* Snippet list */}
        <div className="flex-1 overflow-y-auto">
          {query.trim() ? (
            /* Search results */
            <section className="py-2">
              {displaySnippets.length > 0 ? (
                displaySnippets.map((s) => (
                  <QuickSnippetRow
                    key={s.id}
                    snippet={s}
                    onExecute={() => void handleExecute(s)}
                  />
                ))
              ) : (
                <p className="text-[length:var(--text-xs)] text-text-muted px-4 py-6 text-center">
                  No snippets match &ldquo;{query}&rdquo;
                </p>
              )}
            </section>
          ) : (
            <>
              {/* Recently used */}
              {recentlyUsed.length > 0 && (
                <section aria-labelledby="recent-heading" className="py-2">
                  <h3
                    id="recent-heading"
                    className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-text-muted"
                  >
                    Recently Used
                  </h3>
                  {recentlyUsed.map((s) => (
                    <QuickSnippetRow
                      key={s.id}
                      snippet={s}
                      onExecute={() => void handleExecute(s)}
                    />
                  ))}
                </section>
              )}

              {/* All snippets */}
              {allSorted.length > 0 && (
                <section aria-labelledby="all-heading" className="py-2 border-t border-border">
                  <h3
                    id="all-heading"
                    className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-text-muted"
                  >
                    All Snippets
                  </h3>
                  {allSorted.map((s) => (
                    <QuickSnippetRow
                      key={s.id}
                      snippet={s}
                      onExecute={() => void handleExecute(s)}
                    />
                  ))}
                </section>
              )}

              {allSorted.length === 0 && (
                <p className="text-[length:var(--text-xs)] text-text-muted px-4 py-8 text-center">
                  No snippets saved yet.
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {/* Variable dialog */}
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

// ─── Row component ────────────────────────────────────────────────────────────

interface QuickSnippetRowProps {
  snippet: Snippet;
  onExecute: () => void;
}

function QuickSnippetRow({ snippet, onExecute }: QuickSnippetRowProps) {
  return (
    <button
      onClick={onExecute}
      title={snippet.command}
      className={[
        "group w-full flex items-center gap-2.5 px-4 py-2 text-left",
        "hover:bg-bg-subtle transition-colors duration-[var(--duration-fast)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
      ].join(" ")}
    >
      <Play
        size={11}
        strokeWidth={2.5}
        className="text-accent shrink-0 opacity-60 group-hover:opacity-100 transition-opacity duration-[var(--duration-fast)]"
        aria-hidden="true"
      />
      <div className="flex-1 min-w-0">
        <p className="text-[length:var(--text-xs)] font-medium text-text-primary truncate leading-tight">
          {snippet.name}
        </p>
        <p className="text-[10px] font-mono text-text-muted truncate mt-0.5 leading-tight">
          {snippet.command}
        </p>
      </div>
    </button>
  );
}
