import { create } from "zustand";
import type { S3Entry, S3BucketInfo, ExplorerClipboard, S3Connection } from "../types";

export interface S3Session {
  sessionId: string;
  label: string;
  currentBucket: string | null;
  currentPrefix: string;
  entries: S3Entry[];
  buckets: S3BucketInfo[];
  loading: boolean;
  error: string | null;
  sortBy: "name" | "size" | "modified";
  sortAsc: boolean;
}

interface S3State {
  sessions: Map<string, S3Session>;
  activeS3SessionId: string | null;
  clipboard: ExplorerClipboard | null;
  connections: S3Connection[];
  loadConnections: () => Promise<void>;
  reorderConnections: (newOrder: S3Connection[]) => Promise<void>;

  openSession: (sessionId: string, label: string) => void;
  closeSession: (sessionId: string) => void;
  setActiveS3Session: (id: string | null) => void;
  setBuckets: (sessionId: string, buckets: S3BucketInfo[]) => void;
  setCurrentBucket: (sessionId: string, bucket: string) => void;
  setEntries: (sessionId: string, prefix: string, entries: S3Entry[]) => void;
  setLoading: (sessionId: string, loading: boolean) => void;
  setError: (sessionId: string, error: string | null) => void;
  setSort: (sessionId: string, sortBy: "name" | "size" | "modified", sortAsc: boolean) => void;
  setClipboard: (clipboard: ExplorerClipboard | null) => void;
}

export const useS3Store = create<S3State>((set, get) => ({
  sessions: new Map(),
  connections: [],
  activeS3SessionId: null,
  clipboard: null,

  openSession: (sessionId, label) =>
    set((state) => {
      const next = new Map(state.sessions);
      next.set(sessionId, {
        sessionId,
        label,
        currentBucket: null,
        currentPrefix: "",
        entries: [],
        buckets: [],
        loading: false,
        error: null,
        sortBy: "name",
        sortAsc: true,
      });
      return { sessions: next, activeS3SessionId: sessionId };
    }),

  closeSession: (sessionId) =>
    set((state) => {
      const next = new Map(state.sessions);
      next.delete(sessionId);
      const newActive = state.activeS3SessionId === sessionId
        ? (next.keys().next().value ?? null)
        : state.activeS3SessionId;
      return { sessions: next, activeS3SessionId: newActive };
    }),

  setActiveS3Session: (id) => set({ activeS3SessionId: id }),

  setBuckets: (sessionId, buckets) =>
    set((state) => {
      const session = state.sessions.get(sessionId);
      if (!session) return state;
      const next = new Map(state.sessions);
      next.set(sessionId, { ...session, buckets, loading: false, error: null });
      return { sessions: next };
    }),

  setCurrentBucket: (sessionId, bucket) =>
    set((state) => {
      const session = state.sessions.get(sessionId);
      if (!session) return state;
      const next = new Map(state.sessions);
      next.set(sessionId, { ...session, currentBucket: bucket, currentPrefix: "", entries: [] });
      return { sessions: next };
    }),

  setEntries: (sessionId, prefix, entries) =>
    set((state) => {
      const session = state.sessions.get(sessionId);
      if (!session) return state;
      const next = new Map(state.sessions);
      next.set(sessionId, { ...session, currentPrefix: prefix, entries, loading: false, error: null });
      return { sessions: next };
    }),

  setLoading: (sessionId, loading) =>
    set((state) => {
      const session = state.sessions.get(sessionId);
      if (!session) return state;
      const next = new Map(state.sessions);
      next.set(sessionId, { ...session, loading });
      return { sessions: next };
    }),

  setError: (sessionId, error) =>
    set((state) => {
      const session = state.sessions.get(sessionId);
      if (!session) return state;
      const next = new Map(state.sessions);
      next.set(sessionId, { ...session, error, loading: false });
      return { sessions: next };
    }),

  setSort: (sessionId, sortBy, sortAsc) =>
    set((state) => {
      const session = state.sessions.get(sessionId);
      if (!session) return state;
      const next = new Map(state.sessions);
      next.set(sessionId, { ...session, sortBy, sortAsc });
      return { sessions: next };
    }),

  setClipboard: (clipboard) =>
    set({ clipboard }),

  loadConnections: async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const conns = await invoke<S3Connection[]>("s3_list_connections");
      set({ connections: conns });
    } catch { /* best-effort */ }
  },

  // Optimistically apply a drag-and-drop reordering, then persist it — mirrors
  // hosts-store/groups-store. The UI updates instantly and the new order is
  // sent to the backend in the background; on failure we roll back so the
  // displayed state never diverges from what's stored.
  reorderConnections: async (newOrder) => {
    const previous = get().connections;
    set({ connections: newOrder });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("reorder_s3_connections", { orderedIds: newOrder.map((c) => c.id) });
    } catch (err) {
      set({ connections: previous });
      throw err;
    }
  },
}));

// E2E test hooks — connection delete + transfer command wrappers so specs
// can drive upload/download without going through the file picker dialog.
if (typeof window !== "undefined") {
  const w = window as unknown as {
    __e2eDeleteS3Connection?: (id: string) => Promise<void>;
    __e2eReloadS3Connections?: () => Promise<void>;
    __e2eS3Order?: () => Promise<string[]>;
    __e2eS3Upload?: (sessionId: string, localPath: string, key: string) => Promise<void>;
    __e2eS3Download?: (sessionId: string, key: string, localPath: string) => Promise<void>;
    __e2eS3UploadFiles?: (sessionId: string, localPaths: string[], prefix: string) => Promise<number>;
  };
  w.__e2eDeleteS3Connection = async (id) => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("s3_delete_connection", { id });
  };
  // Reload the dashboard's S3 connection list (now store-owned) after an
  // out-of-band delete — used by the S3 delete E2E spec.
  w.__e2eReloadS3Connections = async () => {
    await useS3Store.getState().loadConnections();
  };
  // Persisted connection order (labels) — lets the reorder E2E spec confirm the
  // async backend write landed before relaunching to verify it survives a restart.
  w.__e2eS3Order = async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const conns = await invoke<{ label: string }[]>("s3_list_connections");
    return conns.map((c) => c.label);
  };
  w.__e2eS3Upload = async (sessionId, localPath, key) => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("s3_upload_file", { s3SessionId: sessionId, localPath, key });
  };
  w.__e2eS3Download = async (sessionId, key, localPath) => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("s3_download_file", { s3SessionId: sessionId, key, localPath });
  };
  w.__e2eS3UploadFiles = async (sessionId, localPaths, prefix) => {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<number>("s3_upload_files", {
      s3SessionId: sessionId, localPaths, prefix,
    });
  };
}
