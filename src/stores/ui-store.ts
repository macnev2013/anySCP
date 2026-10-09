import { create } from "zustand";

interface UiState {
  sidebarExpanded: boolean;
  editingHostId: string | null;
  snippetPanelOpen: boolean;
  snippetPanelPinned: boolean;

  toggleSidebar: () => void;
  setEditingHostId: (id: string | null) => void;
  toggleSnippetPanel: () => void;
  toggleSnippetPanelPinned: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarExpanded: false,
  editingHostId: null,
  snippetPanelOpen: false,
  snippetPanelPinned: false,

  toggleSidebar: () =>
    set((s) => ({ sidebarExpanded: !s.sidebarExpanded })),

  setEditingHostId: (id) =>
    set({ editingHostId: id }),

  toggleSnippetPanel: () =>
    set((s) => ({ snippetPanelOpen: !s.snippetPanelOpen })),

  toggleSnippetPanelPinned: () =>
    set((s) => ({ snippetPanelPinned: !s.snippetPanelPinned })),
}));

// E2E test hook — lets WebDriver tests open the HostEditModal for a given
// host id without having to drive the right-click context menu (which is
// flaky in WebKitWebDriver). No production code reads this.
if (typeof window !== "undefined") {
  (window as unknown as { __e2eOpenHostEdit?: (id: string | null) => void })
    .__e2eOpenHostEdit = (id) => useUiStore.getState().setEditingHostId(id);
}
