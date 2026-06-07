import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { registerSearchAddon, unregisterSearchAddon } from "./terminal-registry";
import { useSettingsStore } from "./settings-store";
import { useSessionStore } from "./session-store";

/**
 * Module-level registry of live xterm.js instances, keyed by sessionId.
 *
 * xterm holds the scrollback buffer (the user's commands + output history) in
 * memory. React unmounts/remounts the <Terminal> component whenever the layout
 * tree changes shape — e.g. a single pane becoming a split — because the
 * component type at that tree position changes. If the xterm instance were
 * owned by the component's effect, that remount would dispose the buffer and
 * the user would lose their history on every split.
 *
 * So the instance and its host DOM element live here instead, decoupled from
 * the component lifecycle. The component only attaches/detaches the cached
 * element. The instance is disposed only when the session itself is removed.
 */
export interface TerminalEntry {
  term: XTerm;
  /** The element xterm renders into; reparented as the component remounts. */
  element: HTMLDivElement;
  fitAddon: FitAddon;
  /** Pending debounced PTY-resize timer, cleared on dispose. */
  resizeTimer: ReturnType<typeof setTimeout> | null;
}

const instances = new Map<string, TerminalEntry>();

/**
 * ANSI 16-color palettes. xterm.js falls back to its built-in palette when
 * these are unset, and that default green (#0DBC79) is nearly illegible on a
 * light background — so we ship palettes tuned for each background's contrast.
 */
const ANSI_PALETTE_DARK = {
  black: "#2e3436",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#ffffff",
};

const ANSI_PALETTE_LIGHT = {
  black: "#24292e",
  red: "#cf222e",
  green: "#116329",
  yellow: "#953800",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#0550ae",
  brightMagenta: "#8250df",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
};

/** Read OKLCH CSS custom properties and convert to hex for xterm.js. */
export function getTerminalTheme(): Record<string, string> {
  const styles = getComputedStyle(document.documentElement);
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return {};

  function toHex(cssVar: string): string {
    const value = styles.getPropertyValue(cssVar).trim();
    if (!value) return "#000000";
    ctx!.fillStyle = value;
    ctx!.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx!.getImageData(0, 0, 1, 1).data;
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  }

  const ansi =
    document.documentElement.dataset.theme === "light" ? ANSI_PALETTE_LIGHT : ANSI_PALETTE_DARK;

  return {
    background: toHex("--color-bg-base"),
    foreground: toHex("--color-text-primary"),
    cursor: toHex("--color-accent"),
    cursorAccent: toHex("--color-bg-base"),
    selectionBackground: toHex("--color-accent-muted"),
    selectionForeground: toHex("--color-text-primary"),
    ...ansi,
  };
}

function createEntry(sessionId: string): TerminalEntry {
  const settings = useSettingsStore.getState();

  const element = document.createElement("div");
  element.className = "h-full w-full";

  const term = new XTerm({
    cursorBlink: settings.terminalCursorBlink,
    cursorStyle: settings.terminalCursorStyle,
    fontSize: settings.terminalFontSize,
    fontFamily: settings.terminalFontFamily,
    fontWeight: "400",
    fontWeightBold: "600",
    lineHeight: settings.terminalLineHeight,
    letterSpacing: 0,
    scrollback: settings.terminalScrollback,
    theme: getTerminalTheme(),
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(element);

  const entry: TerminalEntry = { term, element, fitAddon, resizeTimer: null };

  // Load search addon asynchronously.
  import("@xterm/addon-search")
    .then(({ SearchAddon }) => {
      // Guard against disposal while the dynamic import was in flight.
      if (!instances.has(sessionId)) return;
      const searchAddon = new SearchAddon();
      term.loadAddon(searchAddon);
      registerSearchAddon(sessionId, searchAddon);
    })
    .catch(() => {
      /* Search unavailable */
    });

  term.attachCustomKeyEventHandler((e) => {
    if (e.metaKey && e.shiftKey && e.key === "s") return false;
    if (e.metaKey && !e.shiftKey && e.key === "t") return false;
    if (e.metaKey && !e.shiftKey && e.key === "b") return false;
    if (e.metaKey && !e.shiftKey && e.key === "w") return false;
    if (e.metaKey && !e.shiftKey && e.key >= "1" && e.key <= "9") return false;
    if (e.metaKey && (e.key === "[" || e.key === "]")) return false;
    if (e.metaKey && !e.shiftKey && e.key === "f") return false;
    // Cmd+K — snippet palette
    if (e.metaKey && !e.shiftKey && e.key === "k") return false;
    if (e.metaKey && e.key.toLowerCase() === "d") return false;
    if (e.metaKey && e.shiftKey && e.key === "Enter") return false;
    if (e.metaKey && e.altKey && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key))
      return false;
    return true;
  });

  term.onData((data) => {
    (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const bytes = Array.from(new TextEncoder().encode(data));
      await invoke("ssh_send_input", { sessionId, data: bytes });
    })();
  });

  // Debounce PTY resize requests; the timer lives on the entry (not a closure
  // local) so disposeTerminal can cancel a pending resize that would otherwise
  // fire ssh_resize_pty against an already-removed session.
  term.onResize(({ cols, rows }) => {
    if (entry.resizeTimer) clearTimeout(entry.resizeTimer);
    entry.resizeTimer = setTimeout(() => {
      entry.resizeTimer = null;
      (async () => {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("ssh_resize_pty", { sessionId, cols, rows });
      })().catch(() => {
        /* session may have been torn down between schedule and fire */
      });
    }, 150);
  });

  // E2E test hook — exposes the xterm instance so tests can read the buffer
  // without poking at canvas/DOM internals.
  if (typeof window !== "undefined") {
    const reg = ((window as unknown as { __e2eTerminals?: Map<string, XTerm> }).__e2eTerminals ??=
      new Map<string, XTerm>());
    reg.set(sessionId, term);
  }

  return entry;
}

/** Get the cached terminal for a session, creating it on first request. */
export function ensureTerminal(sessionId: string): TerminalEntry {
  let entry = instances.get(sessionId);
  if (!entry) {
    entry = createEntry(sessionId);
    instances.set(sessionId, entry);
  }
  return entry;
}

/** Get the cached terminal for a session without creating one. */
export function getTerminal(sessionId: string): TerminalEntry | undefined {
  return instances.get(sessionId);
}

/** Dispose a terminal instance and release all associated resources. */
export function disposeTerminal(sessionId: string): void {
  const entry = instances.get(sessionId);
  if (!entry) return;
  instances.delete(sessionId);
  unregisterSearchAddon(sessionId);
  if (typeof window !== "undefined") {
    (window as unknown as { __e2eTerminals?: Map<string, XTerm> }).__e2eTerminals?.delete(sessionId);
  }
  if (entry.resizeTimer) clearTimeout(entry.resizeTimer);
  entry.element.parentElement?.removeChild(entry.element);
  entry.term.dispose();
}

// Garbage-collect xterm instances when their session is removed from the store.
// The instance must outlive React component remounts (splits, tab switches), so
// the store — the source of truth for which sessions exist — drives disposal.
const unsubscribe = useSessionStore.subscribe((state) => {
  for (const sessionId of instances.keys()) {
    if (!state.sessions.has(sessionId)) {
      disposeTerminal(sessionId);
    }
  }
});

// On HMR, tear down the old subscription and dispose live instances so the
// re-evaluated module starts from a clean Map instead of leaking a stale
// subscription that keeps mutating an orphaned one. No-op in production.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribe();
    for (const sessionId of [...instances.keys()]) {
      disposeTerminal(sessionId);
    }
  });
}
