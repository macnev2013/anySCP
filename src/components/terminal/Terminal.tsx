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
 * Read OKLCH CSS custom properties and convert to hex for xterm.js.
 * Uses a temporary canvas to do the color space conversion.
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

  return {
    background: toHex("--color-bg-base"),
    foreground: toHex("--color-text-primary"),
    cursor: toHex("--color-accent"),
    cursorAccent: toHex("--color-bg-base"),
    selectionBackground: toHex("--color-accent-muted"),
    selectionForeground: toHex("--color-text-primary"),
  };
}

interface TerminalProps {
  sessionId: SessionId;
}

export function Terminal({ sessionId }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  // Read settings — snapshot at mount time (terminal recreated if session changes)
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

      // Try WebGL addon for GPU-accelerated rendering
      import("@xterm/addon-webgl")
        .then(({ WebglAddon }) => {
          if (!disposed) terminal.loadAddon(new WebglAddon());
        })
        .catch(() => { /* Canvas renderer fallback */ });

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

      // Let app-level shortcuts pass through xterm to the document handler.
      // Return false = xterm ignores the key, letting it bubble up.
      terminal.attachCustomKeyEventHandler((e) => {
        // Cmd+Shift+S — snippet panel toggle
        if (e.metaKey && e.shiftKey && e.key === "s") return false;
        // Cmd+T — new host
        if (e.metaKey && !e.shiftKey && e.key === "t") return false;
        // Cmd+B — toggle sidebar
        if (e.metaKey && !e.shiftKey && e.key === "b") return false;
        // Cmd+W — close tab/pane
        if (e.metaKey && !e.shiftKey && e.key === "w") return false;
        // Cmd+1-9 — tab switching
        if (e.metaKey && !e.shiftKey && e.key >= "1" && e.key <= "9") return false;
        // Cmd+[ and Cmd+] — prev/next tab
        if (e.metaKey && (e.key === "[" || e.key === "]")) return false;
        // Cmd+F — terminal search
        if (e.metaKey && !e.shiftKey && e.key === "f") return false;
        // Cmd+D — split horizontal / Cmd+Shift+D — split vertical
        if (e.metaKey && e.key.toLowerCase() === "d") return false;
        // Cmd+Shift+Enter — zoom/unzoom pane
        if (e.metaKey && e.shiftKey && e.key === "Enter") return false;
        // Cmd+Option+Arrow — navigate panes
        if (e.metaKey && e.altKey && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return false;
        return true;
      });

      // Send keystrokes to backend
      terminal.onData((data) => {
        (async () => {
          const { invoke } = await import("@tauri-apps/api/core");
          const bytes = Array.from(new TextEncoder().encode(data));
          await invoke("ssh_send_input", { sessionId, data: bytes });
        })();
      });

      // Handle terminal resize
      terminal.onResize(({ cols, rows }) => {
        debouncedResize(cols, rows);
      });

      // ResizeObserver for container size changes
      observer = new ResizeObserver(() => {
        requestAnimationFrame(() => fitAddonRef.current?.fit());
      });
      observer.observe(containerRef.current);
    });

    return () => {
      disposed = true;
      observer?.disconnect();
      unregisterSearchAddon(sessionId);
      if (terminalRef.current) {
        terminalRef.current.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
      }
    };
  }, [sessionId, debouncedResize]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full bg-bg-base"
      onKeyDown={(e) => {
        // Intercept Cmd+D before xterm can send EOF (\x04) to the shell
        if (e.metaKey && (e.key === "d" || e.key === "D")) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    />
  );
}
