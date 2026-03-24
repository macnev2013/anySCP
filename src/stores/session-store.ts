import { create } from "zustand";
import type {
  Session,
  SessionId,
  HostConfig,
  ConnectionStatus,
  LayoutNode,
  SplitDirection,
} from "../types";

// ─── Layout tree helpers ─────────────────────────────────────────────────────

function replacePane(
  node: LayoutNode,
  targetSessionId: string,
  replacement: LayoutNode,
): LayoutNode {
  if (node.type === "pane") {
    return node.sessionId === targetSessionId ? replacement : node;
  }
  return {
    ...node,
    children: [
      replacePane(node.children[0], targetSessionId, replacement),
      replacePane(node.children[1], targetSessionId, replacement),
    ],
  };
}

function removePane(
  node: LayoutNode,
  targetSessionId: string,
): LayoutNode | null {
  if (node.type === "pane") {
    return node.sessionId === targetSessionId ? null : node;
  }
  const [left, right] = node.children;
  if (left.type === "pane" && left.sessionId === targetSessionId) return right;
  if (right.type === "pane" && right.sessionId === targetSessionId) return left;
  const newLeft = removePane(left, targetSessionId);
  const newRight = removePane(right, targetSessionId);
  if (newLeft === null) return right;
  if (newRight === null) return left;
  return { ...node, children: [newLeft, newRight] };
}

function updateRatioAtPath(
  node: LayoutNode,
  path: number[],
  ratio: number,
): LayoutNode {
  if (path.length === 0 && node.type === "split") {
    return { ...node, ratio };
  }
  if (node.type === "pane" || path.length === 0) return node;
  const [idx, ...rest] = path;
  const newChildren = [...node.children] as [LayoutNode, LayoutNode];
  newChildren[idx] = updateRatioAtPath(newChildren[idx], rest, ratio);
  return { ...node, children: newChildren };
}

/** Count total panes in a layout tree. */
export function countPanes(node: LayoutNode): number {
  if (node.type === "pane") return 1;
  return countPanes(node.children[0]) + countPanes(node.children[1]);
}

/** Get the top-level split direction (null if single pane). */
export function getTopDirection(node: LayoutNode): SplitDirection | null {
  if (node.type === "pane") return null;
  return node.direction;
}

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

function containsSession(node: LayoutNode, sessionId: string): boolean {
  if (node.type === "pane") return node.sessionId === sessionId;
  return containsSession(node.children[0], sessionId) || containsSession(node.children[1], sessionId);
}

/** Collect all session IDs from a layout tree. */
function collectSessionIds(node: LayoutNode): string[] {
  if (node.type === "pane") return [node.sessionId];
  return [...collectSessionIds(node.children[0]), ...collectSessionIds(node.children[1])];
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
  tabOrder: string[];
  activeTabId: string | null;
  zoomedPaneId: string | null;

  addSession: (id: SessionId, hostConfig: HostConfig) => void;
  removeSession: (id: SessionId) => void;
  setActiveSession: (id: SessionId | null) => void;
  setActiveTab: (tabId: string) => void;
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
  tabOrder: [],
  activeTabId: null,
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

      // New connection = new tab
      const tabs = new Map(state.tabs);
      tabs.set(id, {
        layout: { type: "pane", sessionId: id },
        label: `${hostConfig.username}@${hostConfig.host}`,
      });

      return {
        sessions,
        activeSessionId: id,
        tabs,
        tabOrder: [...state.tabOrder, id],
        activeTabId: id,
      };
    }),

  removeSession: (id) =>
    set((state) => {
      const sessions = new Map(state.sessions);
      sessions.delete(id);

      const tabs = new Map(state.tabs);
      let tabOrder = [...state.tabOrder];
      let activeTabId = state.activeTabId;

      // Find which tab this session belongs to
      const ownerTabId = findTabForSession(state.tabs, id);

      if (ownerTabId) {
        const tab = tabs.get(ownerTabId);
        if (tab) {
          if (ownerTabId === id && tab.layout.type === "pane") {
            // This session IS the tab and it's the only pane — remove the tab
            tabs.delete(ownerTabId);
            tabOrder = tabOrder.filter((t) => t !== ownerTabId);
            if (activeTabId === ownerTabId) {
              activeTabId = tabOrder.length > 0 ? tabOrder[tabOrder.length - 1] : null;
            }
          } else {
            // Session is in a split — remove it from the tree
            const newLayout = removePane(tab.layout, id);
            if (newLayout) {
              tabs.set(ownerTabId, { ...tab, layout: newLayout });
            } else {
              // Tree collapsed entirely (shouldn't happen, but handle it)
              tabs.delete(ownerTabId);
              tabOrder = tabOrder.filter((t) => t !== ownerTabId);
              if (activeTabId === ownerTabId) {
                activeTabId = tabOrder.length > 0 ? tabOrder[tabOrder.length - 1] : null;
              }
            }
          }
        }
      }

      // Pick a new active session
      let activeSessionId = state.activeSessionId;
      if (activeSessionId === id) {
        if (activeTabId) {
          const activeTab = tabs.get(activeTabId);
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
        tabOrder,
        activeTabId,
        zoomedPaneId: state.zoomedPaneId === id ? null : state.zoomedPaneId,
      };
    }),

  setActiveSession: (id) =>
    set((state) => {
      if (!id) return { activeSessionId: null };
      // Also activate the tab that contains this session
      const tabId = findTabForSession(state.tabs, id);
      return {
        activeSessionId: id,
        activeTabId: tabId ?? state.activeTabId,
      };
    }),

  setActiveTab: (tabId) =>
    set((state) => {
      const tab = state.tabs.get(tabId);
      if (!tab) return state;
      // Focus the first pane in the tab
      const ids = collectSessionIds(tab.layout);
      return {
        activeTabId: tabId,
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
          { type: "pane", sessionId: targetSessionId },
          { type: "pane", sessionId: newSessionId },
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
