import { create } from "zustand";
import type { ExplorerEntry, ExplorerClipboard } from "../types/explorer";

type SortBy = "name" | "size" | "modified";

/** Browsing state for one local pane. Local `local_*` commands are stateless,
 *  so a pane is just its cwd + listing, keyed so each tab keeps its own. */
export interface LocalPane {
  currentPath: string;
  entries: ExplorerEntry[];
  loading: boolean;
  error: string | null;
  sortBy: SortBy;
  sortAsc: boolean;
}

const EMPTY_PANE: LocalPane = {
  currentPath: "",
  entries: [],
  loading: false,
  error: null,
  sortBy: "name",
  sortAsc: true,
};

interface LocalState {
  panes: Map<string, LocalPane>;
  /** Single copy/cut clipboard shared across local panes; paste is gated to the
   *  pane that filled it via `sourceSessionId` (same as the sftp store). */
  clipboard: ExplorerClipboard | null;
  setEntries: (paneKey: string, path: string, entries: ExplorerEntry[]) => void;
  setLoading: (paneKey: string, loading: boolean) => void;
  setError: (paneKey: string, error: string | null) => void;
  setSort: (paneKey: string, sortBy: SortBy, sortAsc: boolean) => void;
  setClipboard: (clipboard: ExplorerClipboard | null) => void;
  closePane: (paneKey: string) => void;
}

// Panes are created lazily on first write (upsert), so a fresh pane needs no
// explicit open — the Explorer's mount effect just calls setEntries.
function patch(panes: Map<string, LocalPane>, key: string, p: Partial<LocalPane>): Map<string, LocalPane> {
  const next = new Map(panes);
  next.set(key, { ...(next.get(key) ?? EMPTY_PANE), ...p });
  return next;
}

export const useLocalStore = create<LocalState>((set) => ({
  panes: new Map(),
  clipboard: null,
  // Like the sftp/s3 stores, a completed listing (or an error) also clears
  // `loading` — loadDirectory relies on that instead of a separate setLoading.
  setEntries: (paneKey, path, entries) =>
    set((s) => ({ panes: patch(s.panes, paneKey, { currentPath: path, entries, loading: false, error: null }) })),
  setLoading: (paneKey, loading) =>
    set((s) => ({ panes: patch(s.panes, paneKey, { loading }) })),
  setError: (paneKey, error) =>
    set((s) => ({ panes: patch(s.panes, paneKey, { error, loading: false }) })),
  setSort: (paneKey, sortBy, sortAsc) =>
    set((s) => ({ panes: patch(s.panes, paneKey, { sortBy, sortAsc }) })),
  setClipboard: (clipboard) => set({ clipboard }),
  closePane: (paneKey) =>
    set((s) => {
      const next = new Map(s.panes);
      next.delete(paneKey);
      return { panes: next };
    }),
}));
