import { create } from "zustand";
import type {
  Session,
  SessionId,
  HostConfig,
  ConnectionStatus,
  LayoutNode,
  SplitDirection,
} from "../types";
import {
  replacePane,
  removePane,
  updateRatioAtPath,
  containsSession,
  collectSessionIds,
} from "../lib/layout-tree";

// Re-exported so existing importers (e.g. UnifiedTabBar) keep working while the
// helpers live in the shared layout-tree module.
export { countPanes, getTopDirection } from "../lib/layout-tree";

// ─── Layout tree helpers ─────────────────────────────────────────────────────

/** Find which tab a session belongs to. */
function findTabForSession(
  tabs: Map<string, Tab>,
  sessionId: string,
): string | null {
  for (const [tabId, tab] of tabs) {
    if (containsSession(tab.layout, sessionId)) return tabId;
  }
  return null;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Tab {
  layout: LayoutNode;
  label: string;
}

interface SessionState {
  sessions: Map<SessionId, Session>;
  activeSessionId: SessionId | null;
  /** Each tab owns its own layout tree. Tab ID = the first session's ID. */
  tabs: Map<string, Tab>;
  /** Which terminal tab is focused (used by PaneHeader / TerminalArea for split detection). */
  activeTerminalTabId: string | null;
  zoomedPaneId: string | null;

  addSession: (id: SessionId, hostConfig: HostConfig) => void;
  removeSession: (id: SessionId) => void;
  setActiveSession: (id: SessionId | null) => void;
  /** Called by tab-store when a terminal tab is activated. Sets activeSessionId from the layout tree. */
  focusTab: (tabId: string) => void;
  updateStatus: (id: SessionId, status: ConnectionStatus, message?: string) => void;
  splitPane: (direction: SplitDirection, targetSessionId: string, newSessionId: string) => void;
  unsplitPane: (sessionId: string) => void;
  updateSplitRatio: (tabId: string, path: number[], ratio: number) => void;
  toggleZoom: (sessionId: string) => void;
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useSessionStore = create<SessionState>((set) => ({
  sessions: new Map(),
  activeSessionId: null,
  tabs: new Map(),
  activeTerminalTabId: null,
  zoomedPaneId: null,

  addSession: (id, hostConfig) =>
    set((state) => {
      const sessions = new Map(state.sessions);
      sessions.set(id, {
        id,
        hostConfig,
        status: "Connected",
        label: `${hostConfig.username}@${hostConfig.host}`,
      });

      // New connection = new layout tree entry
      const tabs = new Map(state.tabs);
      tabs.set(id, {
        layout: { type: "pane", content: { kind: "terminal", sessionId: id } },
        label: `${hostConfig.username}@${hostConfig.host}`,
      });

      return {
        sessions,
        activeSessionId: id,
        tabs,
        activeTerminalTabId: id,
      };
    }),

  removeSession: (id) =>
    set((state) => {
      const sessions = new Map(state.sessions);
      sessions.delete(id);

      const tabs = new Map(state.tabs);
      let activeTerminalTabId = state.activeTerminalTabId;

      // Find which tab this session belongs to
      const ownerTabId = findTabForSession(state.tabs, id);

      if (ownerTabId) {
        const tab = tabs.get(ownerTabId);
        if (tab) {
          if (ownerTabId === id && tab.layout.type === "pane") {
            // This session IS the tab and it's the only pane — remove the layout
            tabs.delete(ownerTabId);
            if (activeTerminalTabId === ownerTabId) {
              activeTerminalTabId = null;
            }
          } else {
            // Session is in a split — remove it from the tree
            const newLayout = removePane(tab.layout, id);
            if (newLayout) {
              tabs.set(ownerTabId, { ...tab, layout: newLayout });
            } else {
              tabs.delete(ownerTabId);
              if (activeTerminalTabId === ownerTabId) {
                activeTerminalTabId = null;
              }
            }
          }
        }
      }

      // Pick a new active session
      let activeSessionId = state.activeSessionId;
      if (activeSessionId === id) {
        if (activeTerminalTabId) {
          const activeTab = tabs.get(activeTerminalTabId);
          if (activeTab) {
            const ids = collectSessionIds(activeTab.layout);
            activeSessionId = ids[0] ?? null;
          } else {
            activeSessionId = null;
          }
        } else {
          activeSessionId = null;
        }
      }

      return {
        sessions,
        activeSessionId,
        tabs,
        activeTerminalTabId,
        zoomedPaneId: state.zoomedPaneId === id ? null : state.zoomedPaneId,
      };
    }),

  setActiveSession: (id) =>
    set((state) => {
      if (!id) return { activeSessionId: null };
      const tabId = findTabForSession(state.tabs, id);
      return {
        activeSessionId: id,
        activeTerminalTabId: tabId ?? state.activeTerminalTabId,
      };
    }),

  focusTab: (tabId) =>
    set((state) => {
      const tab = state.tabs.get(tabId);
      if (!tab) return state;
      const ids = collectSessionIds(tab.layout);
      return {
        activeTerminalTabId: tabId,
        activeSessionId: ids[0] ?? state.activeSessionId,
      };
    }),

  updateStatus: (id, status, message) =>
    set((state) => {
      const session = state.sessions.get(id);
      if (!session) return state;
      const sessions = new Map(state.sessions);
      sessions.set(id, { ...session, status, statusMessage: message });
      return { sessions };
    }),

  splitPane: (direction, targetSessionId, newSessionId) =>
    set((state) => {
      const tabId = findTabForSession(state.tabs, targetSessionId);
      if (!tabId) return state;
      const tab = state.tabs.get(tabId);
      if (!tab) return state;

      // Create the new session from the source
      const sourceSession = state.sessions.get(targetSessionId);
      const sessions = new Map(state.sessions);
      if (sourceSession) {
        sessions.set(newSessionId, {
          id: newSessionId,
          hostConfig: sourceSession.hostConfig,
          status: "Connected",
          label: sourceSession.label,
        });
      }

      const splitNode: LayoutNode = {
        type: "split",
        direction,
        ratio: 0.5,
        children: [
          { type: "pane", content: { kind: "terminal", sessionId: targetSessionId } },
          { type: "pane", content: { kind: "terminal", sessionId: newSessionId } },
        ],
      };

      const newLayout = replacePane(tab.layout, targetSessionId, splitNode);
      const tabs = new Map(state.tabs);
      tabs.set(tabId, { ...tab, layout: newLayout });

      return { sessions, tabs, activeSessionId: newSessionId };
    }),

  unsplitPane: (sessionId) =>
    set((state) => {
      const tabId = findTabForSession(state.tabs, sessionId);
      if (!tabId) return state;
      const tab = state.tabs.get(tabId);
      if (!tab) return state;

      const newLayout = removePane(tab.layout, sessionId);
      if (!newLayout) return state;

      const tabs = new Map(state.tabs);
      tabs.set(tabId, { ...tab, layout: newLayout });
      return { tabs };
    }),

  updateSplitRatio: (tabId, path, ratio) =>
    set((state) => {
      const tab = state.tabs.get(tabId);
      if (!tab) return state;
      const newLayout = updateRatioAtPath(tab.layout, path, ratio);
      const tabs = new Map(state.tabs);
      tabs.set(tabId, { ...tab, layout: newLayout });
      return { tabs };
    }),

  toggleZoom: (sessionId) =>
    set((state) => ({
      zoomedPaneId: state.zoomedPaneId === sessionId ? null : sessionId,
      activeSessionId: sessionId,
    })),
}));
