import { create } from "zustand";

export type ActivePage = "hosts" | "terminal" | "port-forwarding" | "snippets" | "history" | "sftp" | "s3" | "settings";

interface UiState {
  sidebarExpanded: boolean;
  sidebarWidth: number;
  quickConnectOpen: boolean;
  activePage: ActivePage;
  editingHostId: string | null;
  snippetPanelOpen: boolean;
  snippetPanelPinned: boolean;

  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  setQuickConnectOpen: (open: boolean) => void;
  setActivePage: (page: ActivePage) => void;
  setEditingHostId: (id: string | null) => void;
  toggleSnippetPanel: () => void;
  toggleSnippetPanelPinned: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarExpanded: false,
  sidebarWidth: 240,
  quickConnectOpen: false,
  activePage: "hosts",
  editingHostId: null,
  snippetPanelOpen: false,
  snippetPanelPinned: false,

  toggleSidebar: () =>
    set((s) => ({ sidebarExpanded: !s.sidebarExpanded })),

  setSidebarWidth: (width) =>
    set({ sidebarWidth: Math.max(180, Math.min(400, width)) }),

  setQuickConnectOpen: (open) =>
    set({ quickConnectOpen: open }),

  setActivePage: (page) =>
    set({ activePage: page }),

  setEditingHostId: (id) =>
    set({ editingHostId: id }),

  toggleSnippetPanel: () =>
    set((s) => ({ snippetPanelOpen: !s.snippetPanelOpen })),

  toggleSnippetPanelPinned: () =>
    set((s) => ({ snippetPanelPinned: !s.snippetPanelPinned })),
}));
