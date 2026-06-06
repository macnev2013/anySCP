import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useSshOutput } from "../../hooks/use-ssh-events";
import { useDebouncedCallback } from "../../hooks/use-debounce";
import { registerSearchAddon, unregisterSearchAddon } from "../../stores/terminal-registry";
import { useSettingsStore } from "../../stores/settings-store";
import type { SessionId } from "../../types";

/**
 * ANSI 16-color palettes. xterm.js falls back to its built-in palette when these
 * are unset, and that default green (#0DBC79) is nearly illegible on a light
 * background — so we ship palettes tuned for each background's contrast.
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

/**
 * Read OKLCH CSS custom properties and convert to hex for xterm.js.
 */
function getTerminalTheme(): Record<string, string> {
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

interface TerminalProps {
  sessionId: SessionId;
}

export function Terminal({ sessionId }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const themeMode = useSettingsStore((s) => s.themeMode);
  const fontFamily = useSettingsStore((s) => s.terminalFontFamily);
  const fontSize = useSettingsStore((s) => s.terminalFontSize);
  const lineHeight = useSettingsStore((s) => s.terminalLineHeight);
  const cursorStyle = useSettingsStore((s) => s.terminalCursorStyle);
  const cursorBlink = useSettingsStore((s) => s.terminalCursorBlink);
  const scrollback = useSettingsStore((s) => s.terminalScrollback);

  const settings = useSettingsStore.getState();

  const debouncedResize = useDebouncedCallback(
    (cols: number, rows: number) => {
      (async () => {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("ssh_resize_pty", { sessionId, cols, rows });
      })();
    },
    150,
  );

  useSshOutput(sessionId, (data) => {
    terminalRef.current?.write(data);
  });

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;
    let observer: ResizeObserver | null = null;

    // Wait for fonts to load so xterm measures glyphs correctly
    document.fonts.ready.then(() => {
      if (disposed || !containerRef.current) return;

      const theme = getTerminalTheme();

      const terminal = new XTerm({
        cursorBlink: settings.terminalCursorBlink,
        cursorStyle: settings.terminalCursorStyle,
        fontSize: settings.terminalFontSize,
        fontFamily: settings.terminalFontFamily,
        fontWeight: "400",
        fontWeightBold: "600",
        lineHeight: settings.terminalLineHeight,
        letterSpacing: 0,
        scrollback: settings.terminalScrollback,
        theme,
        allowProposedApi: true,
      });

      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);

      terminal.open(containerRef.current);

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;

      // E2E test hook — exposes the xterm instance so tests can read the buffer
      // without poking at canvas/DOM internals. Stripped trivially by minifiers
      // if anyone ever cares about prod bundle size.
      if (typeof window !== "undefined") {
        const reg = ((window as unknown as { __e2eTerminals?: Map<string, XTerm> }).__e2eTerminals ??=
          new Map<string, XTerm>());
        reg.set(sessionId, terminal);
      }

      // Load search addon
      import("@xterm/addon-search")
        .then(({ SearchAddon }) => {
          if (!disposed) {
            const searchAddon = new SearchAddon();
            terminal.loadAddon(searchAddon);
            registerSearchAddon(sessionId, searchAddon);
          }
        })
        .catch(() => { /* Search unavailable */ });

      // Initial fit after layout settles
      requestAnimationFrame(() => {
        if (!disposed) fitAddon.fit();
      });

      terminal.attachCustomKeyEventHandler((e) => {
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
        if (e.metaKey && e.altKey && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return false;
        return true;
      });

      terminal.onData((data) => {
        (async () => {
          const { invoke } = await import("@tauri-apps/api/core");
          const bytes = Array.from(new TextEncoder().encode(data));
          await invoke("ssh_send_input", { sessionId, data: bytes });
        })();
      });

      terminal.onResize(({ cols, rows }) => {
        debouncedResize(cols, rows);
      });

      // ResizeObserver for container size changes
      observer = new ResizeObserver(() => {
        requestAnimationFrame(() => {
          if (fitAddonRef.current && containerRef.current &&
              containerRef.current.clientWidth > 0 && containerRef.current.clientHeight > 0) {
            fitAddonRef.current.fit();
          }
        });
      });
      observer.observe(containerRef.current);
    });

    return () => {
      disposed = true;
      observer?.disconnect();
      unregisterSearchAddon(sessionId);
      if (typeof window !== "undefined") {
        (window as unknown as { __e2eTerminals?: Map<string, XTerm> })
          .__e2eTerminals?.delete(sessionId);
      }
      if (terminalRef.current) {
        terminalRef.current.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
      }
    };
  }, [sessionId, debouncedResize]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = getTerminalTheme();
    }
  }, [themeMode]);

  // Apply appearance changes to the already-open terminal (not just new ones).
  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;
    term.options.fontFamily = fontFamily;
    term.options.fontSize = fontSize;
    term.options.lineHeight = lineHeight;
    term.options.cursorStyle = cursorStyle;
    term.options.cursorBlink = cursorBlink;
    term.options.scrollback = scrollback;
    // Re-fit so the new glyph metrics recompute rows/cols, then repaint.
    fitAddonRef.current?.fit();
    term.refresh(0, term.rows - 1);
  }, [fontFamily, fontSize, lineHeight, cursorStyle, cursorBlink, scrollback]);

  return (
    <div
      ref={containerRef}
      data-testid={`terminal-${sessionId}`}
      data-session-id={sessionId}
      className="h-full w-full bg-bg-base p-2"
      onKeyDown={(e) => {
        if (e.metaKey && (e.key === "d" || e.key === "D")) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    />
  );
}
