import { useSftpStore } from "../stores/sftp-store";
import { useS3Store } from "../stores/s3-store";
import { useLocalStore } from "../stores/local-store";
import type { ExplorerEntry, ExplorerClipboard, FileSystemProvider } from "../types/explorer";

type SortBy = "name" | "size" | "modified";

/**
 * Normalized browsing state for one explorer pane, read from whichever store
 * backs the provider (sftp/scp → sftp-store, s3 → s3-store). This is the adapter
 * that lets a single container drive every backend: it hides the store shape
 * (e.g. S3's `currentPrefix` vs SFTP's `currentPath`) behind one interface.
 */
export interface PaneState {
  entries: ExplorerEntry[];
  currentPath: string;
  loading: boolean;
  error: string | null;
  sortBy: SortBy;
  sortAsc: boolean;
  clipboard: ExplorerClipboard | null;
  setEntries: (path: string, entries: ExplorerEntry[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setSort: (sortBy: SortBy, sortAsc: boolean) => void;
  setClipboard: (clipboard: ExplorerClipboard | null) => void;
}

export function usePaneState(provider: FileSystemProvider): PaneState {
  const id = provider.sessionId;
  const isS3 = provider.type === "s3";
  const isLocal = provider.type === "local";

  // Every store is subscribed (rules of hooks), but the ones that don't back
  // this provider select a constant so their subscriptions never fire — e.g.
  // copying in an S3 tab won't re-render every SFTP explorer (rerender-defer-reads).
  const sftpSession = useSftpStore((s) => (isS3 || isLocal ? undefined : s.sessions.get(id)));
  const sftpClipboard = useSftpStore((s) => (isS3 || isLocal ? null : s.clipboard));
  const s3Session = useS3Store((s) => (isS3 ? s.sessions.get(id) : undefined));
  const s3Clipboard = useS3Store((s) => (isS3 ? s.clipboard : null));
  const localPane = useLocalStore((s) => (isLocal ? s.panes.get(id) : undefined));
  const localClipboard = useLocalStore((s) => (isLocal ? s.clipboard : null));

  const sftp = useSftpStore.getState();
  const s3 = useS3Store.getState();
  const local = useLocalStore.getState();

  if (isLocal) {
    return {
      entries: localPane?.entries ?? [],
      currentPath: localPane?.currentPath ?? "",
      loading: localPane?.loading ?? false,
      error: localPane?.error ?? null,
      sortBy: localPane?.sortBy ?? "name",
      sortAsc: localPane?.sortAsc ?? true,
      clipboard: localClipboard,
      setEntries: (path, entries) => local.setEntries(id, path, entries),
      setLoading: (loading) => local.setLoading(id, loading),
      setError: (error) => local.setError(id, error),
      setSort: (sortBy, sortAsc) => local.setSort(id, sortBy, sortAsc),
      setClipboard: (c) => local.setClipboard(c),
    };
  }

  if (isS3) {
    return {
      entries: s3Session?.entries ?? [],
      currentPath: s3Session?.currentPrefix ?? "",
      loading: s3Session?.loading ?? false,
      error: s3Session?.error ?? null,
      sortBy: s3Session?.sortBy ?? "name",
      sortAsc: s3Session?.sortAsc ?? true,
      clipboard: s3Clipboard,
      setEntries: (path, entries) => s3.setEntries(id, path, entries),
      setLoading: (loading) => s3.setLoading(id, loading),
      setError: (error) => s3.setError(id, error),
      setSort: (sortBy, sortAsc) => s3.setSort(id, sortBy, sortAsc),
      setClipboard: (c) => s3.setClipboard(c),
    };
  }

  return {
    entries: sftpSession?.entries ?? [],
    currentPath: sftpSession?.currentPath ?? "/",
    loading: sftpSession?.loading ?? false,
    error: sftpSession?.error ?? null,
    sortBy: sftpSession?.sortBy ?? "name",
    sortAsc: sftpSession?.sortAsc ?? true,
    clipboard: sftpClipboard,
    setEntries: (path, entries) => sftp.setEntries(id, path, entries),
    setLoading: (loading) => sftp.setLoading(id, loading),
    setError: (error) => sftp.setError(id, error),
    setSort: (sortBy, sortAsc) => sftp.setSort(id, sortBy, sortAsc),
    setClipboard: (c) => sftp.setClipboard(c),
  };
}
