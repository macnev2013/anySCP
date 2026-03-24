import { useEffect, useRef, useCallback } from "react";
import { X, ChevronUp, ChevronDown, CaseSensitive, Regex } from "lucide-react";
import { useTerminalSearchStore } from "../../stores/terminal-search-store";
import { getSearchAddon } from "../../stores/terminal-registry";

interface TerminalSearchBarProps {
  sessionId: string;
}

// Convert an OKLCH CSS variable to hex for xterm decoration options
function tokenToHex(cssVar: string): string {
  const styles = getComputedStyle(document.documentElement);
  const value = styles.getPropertyValue(cssVar).trim();
  if (!value) return "#333344";
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "#444444";
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

let cachedDecorations: {
  matchBackground: string;
  matchBorder: string;
  matchOverviewRuler: string;
  activeMatchBackground: string;
  activeMatchBorder: string;
  activeMatchColorOverviewRuler: string;
} | null = null;

function getDecorations() {
  if (!cachedDecorations) {
    const accent = tokenToHex("--color-accent");
    const accentMuted = tokenToHex("--color-accent-muted");
    cachedDecorations = {
      matchBackground: accentMuted,
      matchBorder: "transparent",
      matchOverviewRuler: accent,
      activeMatchBackground: accent,
      activeMatchBorder: accent,
      activeMatchColorOverviewRuler: accent,
    };
  }
  return cachedDecorations;
}

// Shared button class
const BTN_CLASS = [
  "flex items-center justify-center w-6 h-6 rounded",
  "transition-colors duration-[var(--duration-fast)]",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
].join(" ");

export function TerminalSearchBar({ sessionId }: TerminalSearchBarProps) {
  const query = useTerminalSearchStore((s) => s.queries.get(sessionId) ?? "");
  const results = useTerminalSearchStore((s) => s.results.get(sessionId));
  const caseSensitive = useTerminalSearchStore((s) => s.caseSensitive);
  const regex = useTerminalSearchStore((s) => s.regex);
  const setQuery = useTerminalSearchStore((s) => s.setQuery);
  const setResults = useTerminalSearchStore((s) => s.setResults);
  const closeSearch = useTerminalSearchStore((s) => s.closeSearch);
  const toggleCaseSensitive = useTerminalSearchStore((s) => s.toggleCaseSensitive);
  const toggleRegex = useTerminalSearchStore((s) => s.toggleRegex);

  const inputRef = useRef<HTMLInputElement>(null);
  const addonRef = useRef(getSearchAddon(sessionId));

  // Focus input on mount
  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // Re-resolve addon (it may load async after first render)
  useEffect(() => {
    if (!addonRef.current) {
      const timer = setTimeout(() => {
        addonRef.current = getSearchAddon(sessionId);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [sessionId]);

  // Subscribe to result changes
  useEffect(() => {
    const addon = addonRef.current ?? getSearchAddon(sessionId);
    addonRef.current = addon;
    if (!addon) return;

    const disposable = addon.onDidChangeResults((e: { resultIndex: number; resultCount: number }) => {
      setResults(sessionId, e.resultIndex + 1, e.resultCount);
    });

    return () => disposable.dispose();
  }, [sessionId, setResults]);

  const doSearch = useCallback((term: string, incremental: boolean) => {
    const addon = addonRef.current ?? getSearchAddon(sessionId);
    addonRef.current = addon;
    if (!addon || !term) {
      addon?.clearDecorations();
      setResults(sessionId, 0, 0);
      return;
    }
    addon.findNext(term, {
      caseSensitive,
      regex,
      incremental,
      decorations: getDecorations(),
    });
  }, [sessionId, caseSensitive, regex, setResults]);

  // Re-search when toggles change
  useEffect(() => {
    if (query) doSearch(query, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseSensitive, regex]);

  const handleInput = (value: string) => {
    setQuery(sessionId, value);
    doSearch(value, true);
  };

  const handleNext = () => {
    const addon = addonRef.current ?? getSearchAddon(sessionId);
    if (addon && query) addon.findNext(query, { caseSensitive, regex, decorations: getDecorations() });
  };

  const handlePrev = () => {
    const addon = addonRef.current ?? getSearchAddon(sessionId);
    if (addon && query) addon.findPrevious(query, { caseSensitive, regex, decorations: getDecorations() });
  };

  const handleClose = () => {
    const addon = addonRef.current ?? getSearchAddon(sessionId);
    addon?.clearDecorations();
    closeSearch(sessionId);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      handleClose();
    } else if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      handlePrev();
    } else if (e.key === "Enter") {
      e.preventDefault();
      handleNext();
    }
  };

  // Match count display
  const matchText = !query
    ? ""
    : results && results.count > 0
      ? `${results.index} of ${results.count}`
      : query
        ? "No results"
        : "";

  return (
    <div
      className={[
        "absolute top-2 right-3 z-20",
        "flex items-center gap-1 px-2 py-1.5",
        "bg-bg-overlay border border-border rounded-lg",
        "shadow-[var(--shadow-md)]",
        "animate-[fadeIn_100ms_var(--ease-expo-out)_both]",
      ].join(" ")}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Search input */}
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => handleInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find"
        aria-label="Search terminal"
        className={[
          "w-[160px] px-2 py-1 rounded text-[length:var(--text-xs)]",
          "bg-bg-base border border-border text-text-primary placeholder:text-text-muted",
          "outline-none focus:border-border-focus focus:ring-1 focus:ring-ring",
          "transition-[border-color,box-shadow] duration-[var(--duration-fast)]",
        ].join(" ")}
      />

      {/* Match count */}
      {matchText && (
        <span className="text-[length:var(--text-2xs)] text-text-muted tabular-nums whitespace-nowrap px-1">
          {matchText}
        </span>
      )}

      {/* Prev / Next */}
      <button
        onClick={handlePrev}
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
        disabled={!query || !results?.count}
        className={`${BTN_CLASS} text-text-muted hover:text-text-primary hover:bg-bg-subtle disabled:opacity-30`}
      >
        <ChevronUp size={13} strokeWidth={2} aria-hidden="true" />
      </button>
      <button
        onClick={handleNext}
        title="Next match (Enter)"
        aria-label="Next match"
        disabled={!query || !results?.count}
        className={`${BTN_CLASS} text-text-muted hover:text-text-primary hover:bg-bg-subtle disabled:opacity-30`}
      >
        <ChevronDown size={13} strokeWidth={2} aria-hidden="true" />
      </button>

      {/* Separator */}
      <span className="w-px h-4 bg-border shrink-0" aria-hidden="true" />

      {/* Toggles */}
      <button
        onClick={toggleCaseSensitive}
        title="Match case"
        aria-label="Toggle case sensitivity"
        aria-pressed={caseSensitive}
        className={`${BTN_CLASS} ${caseSensitive ? "text-accent bg-accent/10" : "text-text-muted hover:text-text-primary hover:bg-bg-subtle"}`}
      >
        <CaseSensitive size={14} strokeWidth={1.8} aria-hidden="true" />
      </button>
      <button
        onClick={toggleRegex}
        title="Use regex"
        aria-label="Toggle regex"
        aria-pressed={regex}
        className={`${BTN_CLASS} ${regex ? "text-accent bg-accent/10" : "text-text-muted hover:text-text-primary hover:bg-bg-subtle"}`}
      >
        <Regex size={14} strokeWidth={1.8} aria-hidden="true" />
      </button>

      {/* Separator */}
      <span className="w-px h-4 bg-border shrink-0" aria-hidden="true" />

      {/* Close */}
      <button
        onClick={handleClose}
        title="Close (Escape)"
        aria-label="Close search"
        className={`${BTN_CLASS} text-text-muted hover:text-text-primary hover:bg-bg-subtle`}
      >
        <X size={13} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}
