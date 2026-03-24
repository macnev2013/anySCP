import { create } from "zustand";
import type { Snippet, SnippetFolder, SnippetSearchResult } from "../types";

interface SnippetsState {
  snippets: Snippet[];
  folders: SnippetFolder[];
  searchResults: SnippetSearchResult[];
  searchQuery: string;
  loading: boolean;

  loadSnippets: (folderId?: string | null) => Promise<void>;
  loadFolders: () => Promise<void>;
  saveSnippet: (snippet: Snippet) => Promise<void>;
  deleteSnippet: (id: string) => Promise<void>;
  saveFolder: (folder: SnippetFolder) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  search: (query: string) => Promise<void>;
  clearSearch: () => void;
}

export const useSnippetsStore = create<SnippetsState>((set, get) => ({
  snippets: [],
  folders: [],
  searchResults: [],
  searchQuery: "",
  loading: false,

  loadSnippets: async (folderId) => {
    set({ loading: true });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const snippets = await invoke<Snippet[]>("list_snippets", {
        folderId: folderId ?? null,
      });
      set({ snippets });
    } catch {
      // Non-fatal — keep existing snippets
    } finally {
      set({ loading: false });
    }
  },

  loadFolders: async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const folders = await invoke<SnippetFolder[]>("list_snippet_folders");
      set({ folders });
    } catch {
      // Non-fatal
    }
  },

  saveSnippet: async (snippet) => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_snippet", { snippet });
    // Reload snippets in the current folder context
    const snippets = await invoke<Snippet[]>("list_snippets", { folderId: null });
    set({ snippets });
  },

  deleteSnippet: async (id) => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("delete_snippet", { id });
    set((state) => ({ snippets: state.snippets.filter((s) => s.id !== id) }));
  },

  saveFolder: async (folder) => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_snippet_folder", { folder });
    const folders = await invoke<SnippetFolder[]>("list_snippet_folders");
    set({ folders });
  },

  deleteFolder: async (id) => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("delete_snippet_folder", { id });
    const [folders, snippets] = await Promise.all([
      invoke<SnippetFolder[]>("list_snippet_folders"),
      invoke<Snippet[]>("list_snippets", { folderId: null }),
    ]);
    set({ folders, snippets });
  },

  search: async (query) => {
    set({ searchQuery: query });
    if (!query.trim()) {
      set({ searchResults: [] });
      return;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const searchResults = await invoke<SnippetSearchResult[]>("search_snippets", { query });
      // Only apply if the query hasn't changed while we were awaiting
      if (get().searchQuery === query) {
        set({ searchResults });
      }
    } catch {
      // Non-fatal
    }
  },

  clearSearch: () => {
    set({ searchQuery: "", searchResults: [] });
  },
}));
