import { useEffect } from "react";

export interface ShortcutDef {
  /** Lowercase key, e.g. "k", "d", "b", "1"–"9", "[", "]" */
  key: string;
  /** Requires Cmd (mac) / Ctrl (win/linux) */
  meta: boolean;
  shift?: boolean;
  action: () => void;
  /** Only fire when this returns true */
  when?: () => boolean;
}

/**
 * Central keyboard shortcut handler.
 * Call once at AppShell level with the full shortcut table.
 */
export function useKeyboardShortcuts(shortcuts: ShortcutDef[]) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't intercept when typing in a regular input/textarea,
      // but DO intercept in xterm's hidden textarea (class "xterm-helper-textarea")
      const target = e.target as HTMLElement;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") {
        const isXterm = target.classList.contains("xterm-helper-textarea");
        if (!isXterm) return;
      }

      // On macOS, Cmd is meta. On Windows/Linux, Ctrl is meta.
      // On macOS, Ctrl+key combos are terminal control sequences (Ctrl+C, Ctrl+D)
      // and must NOT be intercepted as shortcuts.
      const isMac = navigator.platform.includes("Mac") || navigator.platform === "MacIntel";
      const meta = isMac ? e.metaKey : e.ctrlKey;

      for (const s of shortcuts) {
        if (s.meta !== meta) continue;
        if ((s.shift ?? false) !== e.shiftKey) continue;
        if (e.key.toLowerCase() !== s.key) continue;
        if (s.when && !s.when()) continue;

        e.preventDefault();
        e.stopPropagation();
        s.action();
        return;
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [shortcuts]);
}
