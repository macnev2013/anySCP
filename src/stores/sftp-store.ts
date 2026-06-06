import { create } from "zustand";
import type { SftpEntry, SftpClipboard } from "../types";

// ─── Session shape ────────────────────────────────────────────────────────────

export interface SftpSession {
  sftpSessionId: string;
  sshSessionId: string;
  label: string;
  username: string;
  sudoMode: boolean;
  currentPath: string;
  /** Configured initial directory for this host's file browser (empty = home).
   *  May contain a leading `~` to expand against the remote home directory. */
  startDirectory: string;
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

  openSession: (sftpSessionId: string, sshSessionId: string, label: string, username?: string, sudoMode?: boolean, startDirectory?: string) => void;
  closeSession: (sftpSessionId: string) => void;
  /** Replace an existing session's ID in-place (used by sudo toggle). */
  swapSession: (oldId: string, newId: string, sudoMode: boolean) => void;
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

  openSession: (sftpSessionId, sshSessionId, label, username, sudoMode, startDirectory) =>
    set((state) => {
      const next = new Map(state.sessions);
      next.set(sftpSessionId, {
        sftpSessionId,
        sshSessionId,
        label,
        username: username ?? "",
        sudoMode: sudoMode ?? false,
        currentPath: "/",
        startDirectory: startDirectory ?? "",
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

  swapSession: (oldId, newId, sudoMode) =>
    set((state) => {
      const old = state.sessions.get(oldId);
      if (!old) return state;
      const next = new Map(state.sessions);
      next.delete(oldId);
      // Keep currentPath (via ...old) so the remounted view reloads the same
      // directory; only the entries are cleared pending the fresh listing.
      next.set(newId, { ...old, sftpSessionId: newId, sudoMode, entries: [], loading: false, error: null });
      const newActive = state.activeSftpSessionId === oldId ? newId : state.activeSftpSessionId;
      // Re-point an outstanding clipboard so a pending cut/copy still pastes
      // after the session id changes.
      const clipboard =
        state.clipboard?.sourceSessionId === oldId
          ? { ...state.clipboard, sourceSessionId: newId }
          : state.clipboard;
      return { sessions: next, activeSftpSessionId: newActive, clipboard };
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

// E2E test hooks — wrap the backend transfer commands so specs can drive
// upload/download/copy/move without going through the (un-driveable) Tauri
// file picker dialog. Each is a thin invoke() wrapper that takes session id
// + paths and returns whatever the backend returns.
if (typeof window !== "undefined") {
  const w = window as unknown as {
    __e2eSftpUpload?: (sessionId: string, localPath: string, remotePath: string) => Promise<string>;
    __e2eSftpDownload?: (sessionId: string, remotePath: string, localPath: string) => Promise<string>;
    __e2eSftpEnqueueUpload?: (sessionId: string, localPaths: string[], remoteDir: string) => Promise<string[]>;
    __e2eSftpCopy?: (sessionId: string, sourcePaths: string[], targetDir: string) => Promise<string[]>;
    __e2eSftpMove?: (sessionId: string, sourcePaths: string[], targetDir: string) => Promise<string[]>;
  };
  w.__e2eSftpUpload = async (sessionId, localPath, remotePath) => {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("sftp_upload", {
      sftpSessionId: sessionId, localPath, remotePath,
    });
  };
  w.__e2eSftpDownload = async (sessionId, remotePath, localPath) => {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("sftp_download", {
      sftpSessionId: sessionId, remotePath, localPath,
    });
  };
  w.__e2eSftpEnqueueUpload = async (sessionId, localPaths, remoteDir) => {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string[]>("sftp_enqueue_upload", {
      sftpSessionId: sessionId, localPaths, remoteDir,
    });
  };
  w.__e2eSftpCopy = async (sessionId, sourcePaths, targetDir) => {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string[]>("sftp_copy_entries", {
      sftpSessionId: sessionId, sourcePaths, targetDir,
    });
  };
  w.__e2eSftpMove = async (sessionId, sourcePaths, targetDir) => {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string[]>("sftp_move_entries", {
      sftpSessionId: sessionId, sourcePaths, targetDir,
    });
  };

  // SCP equivalents — same surface, scp_* commands + scpSessionId key. Used by
  // the SCP fallback E2E spec to drive the wire-protocol transfers.
  const wScp = window as unknown as {
    __e2eScpUpload?: (sessionId: string, localPath: string, remotePath: string) => Promise<string>;
    __e2eScpDownload?: (sessionId: string, remotePath: string, localPath: string) => Promise<string>;
    __e2eScpEnqueueUpload?: (sessionId: string, localPaths: string[], remoteDir: string) => Promise<string[]>;
  };
  wScp.__e2eScpUpload = async (sessionId, localPath, remotePath) => {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("scp_upload", {
      scpSessionId: sessionId, localPath, remotePath,
    });
  };
  wScp.__e2eScpDownload = async (sessionId, remotePath, localPath) => {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("scp_download", {
      scpSessionId: sessionId, remotePath, localPath,
    });
  };
  wScp.__e2eScpEnqueueUpload = async (sessionId, localPaths, remoteDir) => {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string[]>("scp_enqueue_upload", {
      scpSessionId: sessionId, localPaths, remoteDir,
    });
  };
}
