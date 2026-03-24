import { create } from "zustand";
import type { SftpEntry, SftpClipboard } from "../types";

// ─── Session shape ────────────────────────────────────────────────────────────

export interface SftpSession {
  sftpSessionId: string;
  sshSessionId: string;
  label: string;
  currentPath: string;
  entries: SftpEntry[];
  loading: boolean;
  error: string | null;
  sortBy: "name" | "size" | "modified";
  sortAsc: boolean;
}

// ─── Store shape ──────────────────────────────────────────────────────────────

interface SftpState {
  sessions: Map<string, SftpSession>;
  activeSftpSessionId: string | null;
  clipboard: SftpClipboard | null;

  openSession: (sftpSessionId: string, sshSessionId: string, label: string) => void;
  closeSession: (sftpSessionId: string) => void;
  setActiveSftpSession: (id: string | null) => void;
  setEntries: (sftpSessionId: string, path: string, entries: SftpEntry[]) => void;
  setLoading: (sftpSessionId: string, loading: boolean) => void;
  setError: (sftpSessionId: string, error: string | null) => void;
  setSort: (
    sftpSessionId: string,
    sortBy: "name" | "size" | "modified",
    sortAsc: boolean,
  ) => void;
  setClipboard: (clipboard: SftpClipboard | null) => void;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useSftpStore = create<SftpState>((set) => ({
  sessions: new Map(),
  activeSftpSessionId: null,
  clipboard: null,

  openSession: (sftpSessionId, sshSessionId, label) =>
    set((state) => {
      const next = new Map(state.sessions);
      next.set(sftpSessionId, {
        sftpSessionId,
        sshSessionId,
        label,
        currentPath: "/",
        entries: [],
        loading: false,
        error: null,
        sortBy: "name",
        sortAsc: true,
      });
      return { sessions: next, activeSftpSessionId: sftpSessionId };
    }),

  closeSession: (sftpSessionId) =>
    set((state) => {
      const next = new Map(state.sessions);
      next.delete(sftpSessionId);
      const newActive =
        state.activeSftpSessionId === sftpSessionId
          ? (next.keys().next().value ?? null)
          : state.activeSftpSessionId;
      return { sessions: next, activeSftpSessionId: newActive };
    }),

  setActiveSftpSession: (id) =>
    set({ activeSftpSessionId: id }),

  setEntries: (sftpSessionId, path, entries) =>
    set((state) => {
      const session = state.sessions.get(sftpSessionId);
      if (!session) return state;
      const next = new Map(state.sessions);
      next.set(sftpSessionId, { ...session, currentPath: path, entries, loading: false, error: null });
      return { sessions: next };
    }),

  setLoading: (sftpSessionId, loading) =>
    set((state) => {
      const session = state.sessions.get(sftpSessionId);
      if (!session) return state;
      const next = new Map(state.sessions);
      next.set(sftpSessionId, { ...session, loading });
      return { sessions: next };
    }),

  setError: (sftpSessionId, error) =>
    set((state) => {
      const session = state.sessions.get(sftpSessionId);
      if (!session) return state;
      const next = new Map(state.sessions);
      next.set(sftpSessionId, { ...session, error, loading: false });
      return { sessions: next };
    }),

  setSort: (sftpSessionId, sortBy, sortAsc) =>
    set((state) => {
      const session = state.sessions.get(sftpSessionId);
      if (!session) return state;
      const next = new Map(state.sessions);
      next.set(sftpSessionId, { ...session, sortBy, sortAsc });
      return { sessions: next };
    }),

  setClipboard: (clipboard) =>
    set({ clipboard }),
}));
