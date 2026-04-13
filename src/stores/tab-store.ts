import { create } from "zustand";
import { useSessionStore } from "./session-store";
import { useSftpStore } from "./sftp-store";
import { useS3Store } from "./s3-store";
import { useRdpStore } from "./rdp-store";

// ─── Types ──────────────────────────────────────────────────────────────────

export type PageId = "hosts" | "snippets" | "port-forwarding" | "history" | "settings";

export type UnifiedTab =
  | { type: "terminal"; id: string; label: string }
  | { type: "sftp"; id: string; label: string }
  | { type: "s3"; id: string; label: string }
  | { type: "rdp"; id: string; label: string }
  | { type: "page"; id: string; label: string; page: PageId };

export function getTabType(tab: UnifiedTab): string {
  return tab.type === "page" ? tab.page : tab.type;
}

// ─── Store ──────────────────────────────────────────────────────────────────

interface TabState {
  tabs: Map<string, UnifiedTab>;
  tabOrder: string[];
  activeTabId: string | null;

  addTab: (tab: UnifiedTab) => void;
  removeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateTabLabel: (id: string, label: string) => void;
  /** Activate or create a singleton page tab. */
  openPageTab: (page: PageId, label: string) => void;
  /** Find the most recent tab of a given type and activate it. Returns false if none found. */
  activateRecentTabOfType: (type: "terminal" | "sftp" | "s3" | "rdp") => boolean;
}

const PAGE_TAB_PREFIX = "page:";

export function pageTabId(page: PageId): string {
  return `${PAGE_TAB_PREFIX}${page}`;
}

export const useTabStore = create<TabState>((set, get) => ({
  tabs: new Map<string, UnifiedTab>([
    [pageTabId("hosts"), { type: "page", id: pageTabId("hosts"), label: "Hosts", page: "hosts" }],
  ]),
  tabOrder: [pageTabId("hosts")],
  activeTabId: pageTabId("hosts"),

  addTab: (tab) =>
    set((state) => {
      const tabs = new Map(state.tabs);
      tabs.set(tab.id, tab);
      const tabOrder = state.tabOrder.includes(tab.id)
        ? state.tabOrder
        : [...state.tabOrder, tab.id];
      return { tabs, tabOrder, activeTabId: tab.id };
    }),

  removeTab: (id) =>
    set((state) => {
      const tabs = new Map(state.tabs);
      tabs.delete(id);
      const tabOrder = state.tabOrder.filter((t) => t !== id);

      let activeTabId = state.activeTabId;
      if (activeTabId === id) {
        // Activate the previous tab, or the next, or hosts fallback
        const oldIdx = state.tabOrder.indexOf(id);
        activeTabId =
          tabOrder[Math.min(oldIdx, tabOrder.length - 1)] ??
          pageTabId("hosts");

        // Ensure hosts tab exists as fallback
        if (!tabs.has(activeTabId)) {
          const hostsId = pageTabId("hosts");
          const hostsTab: UnifiedTab = { type: "page", id: hostsId, label: "Hosts", page: "hosts" };
          tabs.set(hostsId, hostsTab);
          if (!tabOrder.includes(hostsId)) tabOrder.push(hostsId);
          activeTabId = hostsId;
        }

        // Sync domain stores
        syncDomainStores(tabs.get(activeTabId)!);
      }

      return { tabs, tabOrder, activeTabId };
    }),

  setActiveTab: (id) =>
    set((state) => {
      const tab = state.tabs.get(id);
      if (!tab) return state;
      syncDomainStores(tab);
      return { activeTabId: id };
    }),

  updateTabLabel: (id, label) =>
    set((state) => {
      const tab = state.tabs.get(id);
      if (!tab) return state;
      const tabs = new Map(state.tabs);
      tabs.set(id, { ...tab, label });
      return { tabs };
    }),

  openPageTab: (page, label) => {
    const id = pageTabId(page);
    const state = get();
    if (state.tabs.has(id)) {
      get().setActiveTab(id);
    } else {
      get().addTab({ type: "page", id, label, page });
    }
  },

  activateRecentTabOfType: (type) => {
    const state = get();
    // Walk tabOrder in reverse to find the most recent tab of this type
    for (let i = state.tabOrder.length - 1; i >= 0; i--) {
      const tab = state.tabs.get(state.tabOrder[i]);
      if (tab && tab.type === type) {
        get().setActiveTab(tab.id);
        return true;
      }
    }
    return false;
  },
}));

// ─── Domain store sync ──────────────────────────────────────────────────────

function syncDomainStores(tab: UnifiedTab) {
  if (tab.type === "terminal") {
    useSessionStore.getState().focusTab(tab.id);
  } else if (tab.type === "sftp") {
    useSftpStore.getState().setActiveSftpSession(tab.id);
  } else if (tab.type === "s3") {
    useS3Store.getState().setActiveS3Session(tab.id);
  } else if (tab.type === "rdp") {
    useRdpStore.getState().setActiveRdpSession(tab.id);
  }
}
