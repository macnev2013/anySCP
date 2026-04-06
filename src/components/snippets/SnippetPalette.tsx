import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Search, Play, ArrowLeft, AlertTriangle } from "lucide-react";
import type { Snippet } from "../../types";
import { useSnippetsStore } from "../../stores/snippets-store";
import { useSessionStore } from "../../stores/session-store";
import { useUiStore } from "../../stores/ui-store";
import { CustomSelect } from "../shared/CustomSelect";
import {
  extractVariables,
  parseVariables,
  resolveCommand,
  BUILTIN_NAMES,
} from "../../utils/snippet-resolve";

export function SnippetPalette() {
  const open = useUiStore((s) => s.snippetPanelOpen);
  const toggle = useUiStore((s) => s.toggleSnippetPanel);
  const { snippets, loadSnippets } = useSnippetsStore();
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const session = activeSessionId ? sessions.get(activeSessionId) ?? null : null;

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [phase, setPhase] = useState<"browse" | "variables">("browse");
  const [activeSnippet, setActiveSnippet] = useState<Snippet | null>(null);
  const [varValues, setVarValues] = useState<Record<string, string>>({});

  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const firstVarRef = useRef<HTMLInputElement | null>(null);

  // Load snippets when opened
  useEffect(() => {
    if (open) {
      void loadSnippets(null);
      setQuery("");
      setSelectedIndex(0);
      setPhase("browse");
      setActiveSnippet(null);
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open, loadSnippets]);

  // ─── Filtering ────────────────────────────────────────────────────────────

  const filtered = useMemo<Snippet[]>(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? snippets.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.command.toLowerCase().includes(q) ||
            (s.tags && s.tags.toLowerCase().includes(q)),
        )
      : [...snippets].sort((a, b) => {
          // Recently used first, then by use count
          if (a.last_used_at && b.last_used_at) {
            return new Date(b.last_used_at).getTime() - new Date(a.last_used_at).getTime();
          }
          if (a.last_used_at) return -1;
          if (b.last_used_at) return 1;
          return b.use_count - a.use_count;
        });
    return base;
  }, [snippets, query]);

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // ─── Variable helpers ─────────────────────────────────────────────────────

  const enterVariablePhase = useCallback((snippet: Snippet) => {
    const vars = extractVariables(snippet.command);
    const userVars = vars.filter((n) => !BUILTIN_NAMES.includes(n));

    if (userVars.length === 0) {
      // No user variables — execute immediately
      void executeSnippet(snippet, {});
      return;
    }

    const meta = parseVariables(snippet.variables);
    const initial = Object.fromEntries(
      userVars.map((name) => {
        const m = meta.find((v) => v.name === name);
        return [name, m?.default_value ?? ""];
      }),
    );

    setActiveSnippet(snippet);
    setVarValues(initial);
    setPhase("variables");
    requestAnimationFrame(() => firstVarRef.current?.focus());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  const executeSnippet = async (snippet: Snippet, values: Record<string, string>) => {
    if (!activeSessionId) return;
    const resolved = resolveCommand(snippet.command, values, session);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("snippet_execute", {
        sessionId: activeSessionId,
        resolvedCommand: resolved,
        snippetId: snippet.id,
      });
      await loadSnippets(null);
    } catch { /* non-fatal */ }
    toggle();
  };

  const handleVariableSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (activeSnippet) void executeSnippet(activeSnippet, varValues);
  };

  const goBackToBrowse = () => {
    setPhase("browse");
    setActiveSnippet(null);
    requestAnimationFrame(() => searchRef.current?.focus());
  };

  // ─── Keyboard ─────────────────────────────────────────────────────────────

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (phase === "browse") {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
        scrollSelectedIntoView(selectedIndex + 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        scrollSelectedIntoView(selectedIndex - 1);
      } else if (e.key === "Enter" && filtered[selectedIndex]) {
        e.preventDefault();
        enterVariablePhase(filtered[selectedIndex]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        toggle();
      }
    } else if (phase === "variables") {
      if (e.key === "Escape") {
        e.preventDefault();
        goBackToBrowse();
      }
    }
  };

  const scrollSelectedIntoView = (index: number) => {
    requestAnimationFrame(() => {
      const el = listRef.current?.children[index] as HTMLElement | undefined;
      el?.scrollIntoView({ block: "nearest" });
    });
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  if (!open) return null;

  // Variable phase details
  const allVars = activeSnippet ? extractVariables(activeSnippet.command) : [];
  const userVarNames = allVars.filter((n) => !BUILTIN_NAMES.includes(n));
  const variableMeta = activeSnippet ? parseVariables(activeSnippet.variables) : [];
  const hasUnmetRequired = userVarNames.some((name) => {
    const meta = variableMeta.find((v) => v.name === name);
    return meta?.required && !varValues[name]?.trim();
  });

  let varInputIndex = 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={toggle}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-bg-base/60 backdrop-blur-sm" />

      {/* Palette */}
      <div
        className="relative z-10 w-full max-w-[480px] mx-4 rounded-xl bg-bg-overlay border border-border shadow-[var(--shadow-lg)] overflow-hidden animate-[paletteIn_150ms_var(--ease-expo-out)_both]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {phase === "browse" ? (
          <>
            {/* Search */}
            <div className="flex items-center gap-2.5 px-4 h-12 border-b border-border">
              <Search size={15} strokeWidth={2} className="text-text-muted shrink-0" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search snippets..."
                className="flex-1 bg-transparent text-[length:var(--text-sm)] text-text-primary placeholder:text-text-muted outline-none"
              />
              <kbd className="text-[10px] text-text-muted bg-bg-muted px-1.5 py-0.5 rounded font-mono">esc</kbd>
            </div>

            {/* List */}
            <div ref={listRef} className="max-h-[320px] overflow-y-auto py-1">
              {filtered.length === 0 ? (
                <p className="text-[length:var(--text-xs)] text-text-muted px-4 py-8 text-center">
                  {query ? `No snippets match "${query}"` : "No snippets saved yet"}
                </p>
              ) : (
                filtered.map((snippet, i) => (
                  <button
                    key={snippet.id}
                    onClick={() => enterVariablePhase(snippet)}
                    onMouseEnter={() => setSelectedIndex(i)}
                    className={[
                      "w-full flex items-center gap-3 px-4 py-2.5 text-left",
                      "transition-colors duration-75",
                      i === selectedIndex ? "bg-accent/10" : "hover:bg-bg-subtle",
                    ].join(" ")}
                  >
                    <Play
                      size={11}
                      strokeWidth={2.5}
                      className={i === selectedIndex ? "text-accent shrink-0" : "text-text-muted shrink-0"}
                    />
                    <div className="flex-1 min-w-0">
                      <p className={[
                        "text-[length:var(--text-sm)] truncate leading-tight",
                        i === selectedIndex ? "text-accent font-medium" : "text-text-primary",
                      ].join(" ")}>
                        {snippet.name}
                      </p>
                      <p className="text-[10px] font-mono text-text-muted truncate mt-0.5 leading-tight">
                        {snippet.command}
                      </p>
                    </div>
                    {snippet.is_dangerous && (
                      <AlertTriangle size={12} strokeWidth={2} className="text-status-error shrink-0" />
                    )}
                  </button>
                ))
              )}
            </div>

            {/* Footer hint */}
            {filtered.length > 0 && (
              <div className="flex items-center gap-3 px-4 py-2 border-t border-border text-[10px] text-text-muted">
                <span><kbd className="font-mono bg-bg-muted px-1 py-px rounded">↑↓</kbd> navigate</span>
                <span><kbd className="font-mono bg-bg-muted px-1 py-px rounded">↵</kbd> execute</span>
                <span><kbd className="font-mono bg-bg-muted px-1 py-px rounded">esc</kbd> close</span>
              </div>
            )}
          </>
        ) : activeSnippet ? (
          /* Variable phase — inline continuation of the palette */
          <form onSubmit={handleVariableSubmit}>
            {/* Header row — same height as search bar for visual continuity */}
            <div className="flex items-center gap-2 px-4 h-12 border-b border-border">
              <button
                type="button"
                onClick={goBackToBrowse}
                className="p-1 -ml-1 rounded-md text-text-muted hover:text-accent hover:bg-accent/10 transition-colors"
                title="Back (Esc)"
              >
                <ArrowLeft size={14} strokeWidth={2} />
              </button>
              <div className="flex-1 min-w-0">
                <p className="text-[length:var(--text-sm)] font-medium text-text-primary truncate">
                  {activeSnippet.name}
                </p>
              </div>
              {activeSnippet.is_dangerous && (
                <span title="Dangerous command"><AlertTriangle size={13} strokeWidth={2} className="text-status-error shrink-0" /></span>
              )}
              <button
                type="submit"
                disabled={hasUnmetRequired}
                className="flex items-center gap-1.5 h-7 px-3 text-[11px] font-medium rounded-lg text-text-inverse bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
              >
                Run
                <kbd className="text-[9px] opacity-70 font-mono">↵</kbd>
              </button>
            </div>

            {/* Command preview */}
            <div className="px-4 py-2 bg-bg-base/50 border-b border-border/50">
              <p className="text-[10px] font-mono text-text-muted break-all line-clamp-2 leading-relaxed">
                {activeSnippet.command}
              </p>
            </div>

            {/* Variable inputs */}
            <div className="px-4 py-3 flex flex-col gap-2.5">
              {userVarNames.map((name) => {
                const meta = variableMeta.find((v) => v.name === name);
                const isFirst = varInputIndex === 0;
                varInputIndex++;
                const label = meta?.label ?? name;
                const placeholder = meta?.placeholder ?? name;
                const options = meta?.options ?? null;
                const required = meta?.required ?? false;

                const inputCls = "w-full h-9 rounded-lg bg-bg-base border border-border px-3 text-[length:var(--text-sm)] text-text-primary placeholder:text-text-muted font-mono outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 transition-[border-color,box-shadow] duration-[var(--duration-fast)]";

                return (
                  <div key={name}>
                    <label className="block text-[10px] font-medium uppercase tracking-wider text-text-muted mb-1">
                      {label}{required && <span className="text-status-error ml-0.5">*</span>}
                    </label>
                    {options && options.length > 0 ? (
                      <CustomSelect
                        value={varValues[name] ?? ""}
                        onChange={(v) => setVarValues((prev) => ({ ...prev, [name]: v }))}
                        placeholder={placeholder}
                        className="w-full"
                        options={[
                          { value: "", label: `— ${placeholder} —` },
                          ...options.map((opt) => ({ value: opt, label: opt })),
                        ]}
                      />
                    ) : (
                      <input
                        ref={isFirst ? (el) => { firstVarRef.current = el; } : undefined}
                        type="text"
                        value={varValues[name] ?? ""}
                        onChange={(e) => setVarValues((prev) => ({ ...prev, [name]: e.target.value }))}
                        placeholder={placeholder}
                        className={inputCls}
                      />
                    )}
                  </div>
                );
              })}
            </div>

            {/* Footer */}
            <div className="flex items-center gap-3 px-4 py-2 border-t border-border text-[10px] text-text-muted">
              <span><kbd className="font-mono bg-bg-muted px-1 py-px rounded">tab</kbd> next field</span>
              <span><kbd className="font-mono bg-bg-muted px-1 py-px rounded">↵</kbd> run</span>
              <span><kbd className="font-mono bg-bg-muted px-1 py-px rounded">esc</kbd> back</span>
            </div>
          </form>
        ) : null}
      </div>

      <style>{`
        @keyframes paletteIn {
          from { opacity: 0; transform: translateY(-8px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}
