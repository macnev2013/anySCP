import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { useSshOutput } from "../../hooks/use-ssh-events";
import {
  ensureTerminal,
  getTerminal,
  getTerminalTheme,
} from "../../stores/terminal-instances";
import { useSettingsStore } from "../../stores/settings-store";
import type { SessionId } from "../../types";

interface TerminalProps {
  sessionId: SessionId;
}

/**
 * Renders a session's terminal. The xterm.js instance itself is owned by the
 * terminal-instances registry, not this component — see that module for why.
 * This component only mounts the cached host element into the DOM and forwards
 * resize/appearance changes, so the scrollback buffer survives the remounts
 * that happen whenever the surrounding layout changes shape (e.g. on split).
 */
export function Terminal({ sessionId }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const themeMode = useSettingsStore((s) => s.themeMode);
  const fontFamily = useSettingsStore((s) => s.terminalFontFamily);
  const fontSize = useSettingsStore((s) => s.terminalFontSize);
  const lineHeight = useSettingsStore((s) => s.terminalLineHeight);
  const cursorStyle = useSettingsStore((s) => s.terminalCursorStyle);
  const cursorBlink = useSettingsStore((s) => s.terminalCursorBlink);
  const scrollback = useSettingsStore((s) => s.terminalScrollback);

  // Create the instance eagerly on the first byte so early output (banner /
  // MOTD / initial prompt) that lands before the mount effect runs is written
  // into the scrollback rather than dropped. createEntry opens into a detached
  // element; the mount effect later attaches that same cached element.
  useSshOutput(sessionId, (data) => {
    ensureTerminal(sessionId).term.write(data);
  });

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;
    let observer: ResizeObserver | null = null;

    // Wait for fonts to load so xterm measures glyphs correctly.
    document.fonts.ready.then(() => {
      const container = containerRef.current;
      if (disposed || !container) return;

      const { element, fitAddon } = ensureTerminal(sessionId);
      container.appendChild(element);

      // Fit after layout settles, then again whenever the container resizes.
      requestAnimationFrame(() => {
        if (!disposed) fitAddon.fit();
      });

      observer = new ResizeObserver(() => {
        requestAnimationFrame(() => {
          if (
            !disposed &&
            container.clientWidth > 0 &&
            container.clientHeight > 0
          ) {
            fitAddon.fit();
          }
        });
      });
      observer.observe(container);
    });

    return () => {
      disposed = true;
      observer?.disconnect();
      // Detach the cached element but keep the xterm instance (and its
      // scrollback) alive — the registry disposes it when the session ends.
      const entry = getTerminal(sessionId);
      if (entry?.element.parentElement) {
        entry.element.parentElement.removeChild(entry.element);
      }
    };
  }, [sessionId]);

  useEffect(() => {
    const term = getTerminal(sessionId)?.term;
    if (term) term.options.theme = getTerminalTheme();
  }, [sessionId, themeMode]);

  // Apply appearance changes to the already-open terminal (not just new ones).
  useEffect(() => {
    const entry = getTerminal(sessionId);
    if (!entry) return;
    const { term, fitAddon } = entry;
    term.options.fontFamily = fontFamily;
    term.options.fontSize = fontSize;
    term.options.lineHeight = lineHeight;
    term.options.cursorStyle = cursorStyle;
    term.options.cursorBlink = cursorBlink;
    term.options.scrollback = scrollback;
    // Re-fit so the new glyph metrics recompute rows/cols, then repaint.
    fitAddon.fit();
    term.refresh(0, term.rows - 1);
  }, [sessionId, fontFamily, fontSize, lineHeight, cursorStyle, cursorBlink, scrollback]);

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
