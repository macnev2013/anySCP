import { create } from "zustand";
import type { S3Entry, S3BucketInfo, ExplorerClipboard } from "../types";

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

export const useS3Store = create<S3State>((set) => ({
  sessions: new Map(),
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
}));
