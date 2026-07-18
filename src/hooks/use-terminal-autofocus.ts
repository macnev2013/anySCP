import { useEffect } from "react";
import { useTabStore } from "../stores/tab-store";
import { useSessionStore } from "../stores/session-store";
import { useTerminalSearchStore } from "../stores/terminal-search-store";
import { getTerminal } from "../stores/terminal-instances";

/**
 * Focus the active terminal whenever its tab (or split pane) becomes active,
 * so keyboard input lands in the shell without an extra click.
 */
export function useTerminalAutoFocus() {
  const activeTab = useTabStore((s) =>
    s.activeTabId ? s.tabs.get(s.activeTabId) : undefined,
  );
  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  useEffect(() => {
    if (!activeTab || activeTab.type !== "terminal" || !activeSessionId) return;
    // Don't steal focus while the search bar is open for this session —
    // misdirected keys would go into the live shell
    if (useTerminalSearchStore.getState().openSessions.has(activeSessionId))
      return;
    const raf = requestAnimationFrame(() => {
      getTerminal(activeSessionId)?.term.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [activeTab, activeSessionId]);
}
