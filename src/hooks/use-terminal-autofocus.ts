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
    // Yield to the search bar when it was the last-focused element for this
    // session — it restores its own focus, and misdirected keys would go
    // into the live shell
    const search = useTerminalSearchStore.getState();
    if (
      search.openSessions.has(activeSessionId) &&
      search.focusedSessionId === activeSessionId
    )
      return;
    const raf = requestAnimationFrame(() => {
      getTerminal(activeSessionId)?.term.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [activeTab, activeSessionId]);
}
