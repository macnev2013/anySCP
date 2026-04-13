import { create } from "zustand";

interface UiState {
  sidebarExpanded: boolean;
  sidebarWidth: number;
  quickConnectOpen: boolean;
  editingHostId: string | null;
  snippetPanelOpen: boolean;
  snippetPanelPinned: boolean;
  /** Pane IDs that are placeholders waiting for the user to pick a host. */
  pendingPanes: Set<string>;

  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  setQuickConnectOpen: (open: boolean) => void;
  setEditingHostId: (id: string | null) => void;
  toggleSnippetPanel: () => void;
  toggleSnippetPanelPinned: () => void;
  addPendingPane: (id: string) => void;
  removePendingPane: (id: string) => void;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarExpanded: false,
  sidebarWidth: 240,
  quickConnectOpen: false,
  editingHostId: null,
  snippetPanelOpen: false,
  snippetPanelPinned: false,
  pendingPanes: new Set(),

  toggleSidebar: () =>
    set((s) => ({ sidebarExpanded: !s.sidebarExpanded })),

  setSidebarWidth: (width) =>
    set({ sidebarWidth: Math.max(180, Math.min(400, width)) }),

  setQuickConnectOpen: (open) =>
    set({ quickConnectOpen: open }),

  setEditingHostId: (id) =>
    set({ editingHostId: id }),

  toggleSnippetPanel: () =>
    set((s) => ({ snippetPanelOpen: !s.snippetPanelOpen })),

  toggleSnippetPanelPinned: () =>
    set((s) => ({ snippetPanelPinned: !s.snippetPanelPinned })),

  addPendingPane: (id) =>
    set((s) => {
      const pendingPanes = new Set(s.pendingPanes);
      pendingPanes.add(id);
      return { pendingPanes };
    }),

  removePendingPane: (id) =>
    set((s) => {
      const pendingPanes = new Set(s.pendingPanes);
      pendingPanes.delete(id);
      return { pendingPanes };
    }),
}));
