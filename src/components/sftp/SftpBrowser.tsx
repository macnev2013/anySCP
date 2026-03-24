import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { AlertCircle } from "lucide-react";
import { useSftpStore } from "../../stores/sftp-store";
import type { SftpEntry } from "../../types";
import type { ExplorerEntry, ExplorerClipboard } from "../../types/explorer";
import { ExplorerToolbar, ExplorerFileTable, ExplorerDropZone } from "../explorer";
import { createSftpProvider, toExplorerEntry } from "../../providers/sftp-provider";

interface SftpBrowserProps {
  sftpSessionId: string;
}

export function SftpBrowser({ sftpSessionId }: SftpBrowserProps) {
  const session = useSftpStore((s) => s.sessions.get(sftpSessionId));
  const setEntries = useSftpStore((s) => s.setEntries);
  const setLoading = useSftpStore((s) => s.setLoading);
  const setError = useSftpStore((s) => s.setError);
  const setSort = useSftpStore((s) => s.setSort);
  const clipboard = useSftpStore((s) => s.clipboard);
  const setClipboard = useSftpStore((s) => s.setClipboard);

  const provider = useMemo(() => createSftpProvider(sftpSessionId), [sftpSessionId]);

  // ─── Drag-and-drop (OS → App) ─────────────────────────────────────────────

  const [isDragOver, setIsDragOver] = useState(false);
  const isProcessingDrop = useRef(false);
  const currentPathRef = useRef(session?.currentPath ?? "/");
  currentPathRef.current = session?.currentPath ?? "/";

  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | undefined;

    (async () => {
      try {
        type DragDropTarget = { onDragDropEvent: (cb: (e: DragDropEventPayload) => void) => Promise<() => void> };
        let appWindow: DragDropTarget | null = null;

        try {
          const mod = await import("@tauri-apps/api/webviewWindow");
          appWindow = mod.getCurrentWebviewWindow() as unknown as DragDropTarget;
        } catch {
          try {
            const mod2 = await import("@tauri-apps/api/webview");
            if ("getCurrentWebview" in mod2 && typeof mod2.getCurrentWebview === "function") {
              appWindow = (mod2.getCurrentWebview as () => DragDropTarget)();
            }
          } catch {
            // Drag-drop API unavailable
          }
        }

        if (!appWindow || aborted) return;

        const unsub = await appWindow.onDragDropEvent((event: DragDropEventPayload) => {
          const type = event.payload?.type;
          if (type === "enter" || type === "over") {
            setIsDragOver(true);
          } else if (type === "drop") {
            setIsDragOver(false);

            const paths: string[] = event.payload?.paths ?? [];
            if (isProcessingDrop.current || paths.length === 0) return;
            isProcessingDrop.current = true;

            const remoteDir = currentPathRef.current;

            void (async () => {
              try {
                const { invoke } = await import("@tauri-apps/api/core");
                await invoke("sftp_enqueue_upload", {
                  sftpSessionId,
                  localPaths: paths,
                  remoteDir,
                });
              } catch (err) {
                console.error("Drag-drop upload failed:", err);
              } finally {
                setTimeout(() => { isProcessingDrop.current = false; }, 500);
              }
            })();
          } else {
            setIsDragOver(false);
          }
        });

        if (aborted) { unsub(); } else { unlisten = unsub; }
      } catch {
        // Tauri API not available in browser/test context
      }
    })();

    return () => { aborted = true; unlisten?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sftpSessionId]);

  // ─── Auto-refresh on upload completion ────────────────────────────────────

  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (aborted) return;

        const unsub = await listen<{
          sftp_session_id: string;
          direction: string;
          status: string;
        }>("sftp:transfer", (event) => {
          const { sftp_session_id, direction, status } = event.payload;
          if (
            sftp_session_id === sftpSessionId &&
            direction === "Upload" &&
            status === "Completed"
          ) {
            setTimeout(() => {
              const path = currentPathRef.current;
              if (path) void loadDirectory(path);
            }, 300);
          }
        });

        if (aborted) { unsub(); } else { unlisten = unsub; }
      } catch {
        // Not in Tauri context
      }
    })();
    return () => { aborted = true; unlisten?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sftpSessionId]);

  // ─── Navigation ──────────────────────────────────────────────────────────

  const loadDirectory = useCallback(
    async (path: string) => {
      setLoading(sftpSessionId, true);
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const entries = await invoke<SftpEntry[]>("sftp_list_dir", {
          sftpSessionId,
          path,
        });
        setEntries(sftpSessionId, path, entries);
      } catch (err: unknown) {
        const msg =
          err && typeof err === "object" && "message" in err
            ? String((err as { message: string }).message)
            : "Failed to list directory";
        setError(sftpSessionId, msg);
      }
    },
    [sftpSessionId, setLoading, setEntries, setError],
  );

  // On mount: resolve home dir, then load it
  useEffect(() => {
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const homeDir = await invoke<string>("sftp_home_dir", { sftpSessionId });
        await loadDirectory(homeDir);
      } catch {
        await loadDirectory("/");
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sftpSessionId]);

  // ─── Download (enqueue) ───────────────────────────────────────────────────

  const handleDownload = useCallback(async (entry: ExplorerEntry) => {
    try {
      const { open, save } = await import("@tauri-apps/plugin-dialog");
      let localDir: string | null = null;

      if (entry.entryType === "Directory") {
        localDir = await open({ directory: true, title: `Download "${entry.name}" to…` }) as string | null;
      } else {
        const savePath = await save({ defaultPath: entry.name, title: `Save "${entry.name}" as…` });
        if (savePath) {
          const lastSlash = savePath.lastIndexOf("/");
          localDir = lastSlash > 0 ? savePath.substring(0, lastSlash) : savePath;
        }
      }

      if (!localDir) return;

      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("sftp_enqueue_download", {
        sftpSessionId,
        remotePaths: [entry.id],
        localDir,
      });
    } catch (err) {
      console.error("Download enqueue failed:", err);
    }
  }, [sftpSessionId]);

  // ─── Upload (dialog) ─────────────────────────────────────────────────────

  const handleUpload = useCallback(async () => {
    if (!session) return;
    try {
      let localPath: string | null = null;
      try {
        const specifier = ["@tauri-apps", "plugin-dialog"].join("/");
        const dialog = await (Function("s", "return import(s)")(specifier) as Promise<{ open: (opts: { multiple: boolean }) => Promise<string | null> }>);
        const result = await dialog.open({ multiple: false });
        if (result) localPath = result;
      } catch {
        localPath = window.prompt("Enter local file path to upload:");
      }
      if (!localPath) return;

      const fileName = localPath.split("/").pop() ?? localPath.split("\\").pop() ?? "file";
      const remotePath = session.currentPath.endsWith("/")
        ? `${session.currentPath}${fileName}`
        : `${session.currentPath}/${fileName}`;

      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("sftp_upload", { sftpSessionId, localPath, remotePath });
      void loadDirectory(session.currentPath);
    } catch {
      // Upload errors show in transfer overlay
    }
  }, [sftpSessionId, session, loadDirectory]);

  // ─── New folder/file (inline) ─────────────────────────────────────────────

  const [creatingFolder, setCreatingFolder] = useState(false);
  const [creatingFile, setCreatingFile] = useState(false);

  useEffect(() => {
    const folderHandler = () => setCreatingFolder(true);
    const fileHandler = () => setCreatingFile(true);
    document.addEventListener("sftp:new-folder", folderHandler);
    document.addEventListener("sftp:new-file", fileHandler);
    document.addEventListener("explorer:new-folder", folderHandler);
    document.addEventListener("explorer:new-file", fileHandler);
    return () => {
      document.removeEventListener("sftp:new-folder", folderHandler);
      document.removeEventListener("sftp:new-file", fileHandler);
      document.removeEventListener("explorer:new-folder", folderHandler);
      document.removeEventListener("explorer:new-file", fileHandler);
    };
  }, []);

  const handleCreateFile = useCallback(
    async (name: string) => {
      setCreatingFile(false);
      if (!name.trim() || !session) return;
      const filePath = provider.joinPath(session.currentPath, name.trim());
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("sftp_create_file", { sftpSessionId, path: filePath });
        await loadDirectory(session.currentPath);
      } catch {
        // Error shown via refresh
      }
    },
    [sftpSessionId, session, loadDirectory, provider],
  );

  const handleCreateFolder = useCallback(
    async (name: string) => {
      setCreatingFolder(false);
      if (!name.trim() || !session) return;
      const dirPath = provider.joinPath(session.currentPath, name.trim());
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("sftp_mkdir", { sftpSessionId, path: dirPath });
        await loadDirectory(session.currentPath);
      } catch {
        // Error shown via refresh
      }
    },
    [sftpSessionId, session, loadDirectory, provider],
  );

  // ─── Delete ──────────────────────────────────────────────────────────────

  const handleDelete = useCallback(async (entriesToDelete: ExplorerEntry[]) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      for (const entry of entriesToDelete) {
        await invoke("sftp_delete", {
          sftpSessionId,
          path: entry.id,
          isDir: entry.entryType === "Directory",
        });
      }
    } catch {
      // Partial deletes may occur
    }
    if (session) void loadDirectory(session.currentPath);
  }, [sftpSessionId, session, loadDirectory]);

  // ─── Rename ──────────────────────────────────────────────────────────────

  const handleRename = useCallback(async (entry: ExplorerEntry, newName: string) => {
    const parentPath = entry.id.substring(0, entry.id.lastIndexOf("/")) || "/";
    const newPath = `${parentPath}/${newName}`;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("sftp_rename", { sftpSessionId, oldPath: entry.id, newPath });
      if (session) void loadDirectory(session.currentPath);
    } catch (err) {
      console.error("Rename failed:", err);
    }
  }, [sftpSessionId, session, loadDirectory]);

  // ─── Edit in VS Code ─────────────────────────────────────────────────────

  const handleEditInEditor = useCallback((entry: ExplorerEntry) => {
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("sftp_edit_in_vscode", { sftpSessionId, remotePath: entry.id });
      } catch {
        // VS Code may not be installed
      }
    })();
  }, [sftpSessionId]);

  // ─── Paste / Move / Copy ─────────────────────────────────────────────────

  const [busy, setBusy] = useState(false);

  const handlePaste = useCallback(async () => {
    const clip = useSftpStore.getState().clipboard;
    if (!clip || clip.sourceSessionId !== sftpSessionId || !session) return;

    const sourcePaths = clip.entries.map((e) => e.path);
    const targetDir = session.currentPath;

    setBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      if (clip.operation === "cut") {
        await invoke("sftp_move_entries", { sftpSessionId, sourcePaths, targetDir });
        useSftpStore.getState().setClipboard(null);
      } else {
        await invoke("sftp_copy_entries", { sftpSessionId, sourcePaths, targetDir });
      }
      await loadDirectory(session.currentPath);
    } catch (err) {
      setError(sftpSessionId, err instanceof Error ? err.message : "Paste failed");
    } finally {
      setBusy(false);
    }
  }, [sftpSessionId, session, loadDirectory, setError]);

  const handleMoveEntries = useCallback(async (sourceIds: string[], targetDir: string) => {
    setBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("sftp_move_entries", { sftpSessionId, sourcePaths: sourceIds, targetDir });
      if (session) await loadDirectory(session.currentPath);
    } catch (err) {
      setError(sftpSessionId, err instanceof Error ? err.message : "Move failed");
    } finally {
      setBusy(false);
    }
  }, [sftpSessionId, session, loadDirectory, setError]);

  const handleCopyEntries = useCallback(async (sourceIds: string[], targetDir: string) => {
    setBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("sftp_copy_entries", { sftpSessionId, sourcePaths: sourceIds, targetDir });
      if (session) await loadDirectory(session.currentPath);
    } catch (err) {
      setError(sftpSessionId, err instanceof Error ? err.message : "Copy failed");
    } finally {
      setBusy(false);
    }
  }, [sftpSessionId, session, loadDirectory, setError]);

  // ─── Clipboard adapter ───────────────────────────────────────────────────
  // SftpClipboard uses SftpEntry with `path`, ExplorerClipboard uses ExplorerEntry with `id`.
  // We bridge between the two here.

  const explorerClipboard: ExplorerClipboard | null = clipboard
    ? {
        entries: clipboard.entries.map(toExplorerEntry),
        operation: clipboard.operation,
        sourceSessionId: clipboard.sourceSessionId,
      }
    : null;

  const handleSetClipboard = useCallback((clip: ExplorerClipboard | null) => {
    if (!clip) {
      setClipboard(null);
      return;
    }
    // Convert ExplorerEntry back to SftpEntry shape for the sftp store
    const sftpEntries = clip.entries.map((e) => {
      // Find the original sftp entry
      const original = session?.entries.find((se) => se.path === e.id);
      if (original) return original;
      // Fallback: reconstruct minimal SftpEntry
      return {
        name: e.name,
        path: e.id,
        entry_type: e.entryType as "File" | "Directory" | "Symlink" | "Other",
        size: e.size,
        permissions: 0,
        permissions_display: e.permissionsDisplay ?? "",
        modified: e.modified,
        is_symlink: e.isSymlink,
      };
    });
    setClipboard({
      entries: sftpEntries,
      operation: clip.operation,
      sourceSessionId: clip.sourceSessionId,
    });
  }, [setClipboard, session]);

  // ─── Breadcrumb segments ──────────────────────────────────────────────────

  const currentPath = session?.currentPath ?? "/";
  const rawSegments = currentPath.split("/").filter((s) => s.length > 0);
  const segments = [
    { label: "/", path: "/" },
    ...rawSegments.map((seg, i) => ({
      label: seg,
      path: "/" + rawSegments.slice(0, i + 1).join("/"),
    })),
  ];

  // ─── Explorer entries ─────────────────────────────────────────────────────

  const explorerEntries: ExplorerEntry[] = useMemo(
    () => (session?.entries ?? []).map(toExplorerEntry),
    [session?.entries],
  );

  // ─── Guard ────────────────────────────────────────────────────────────────

  if (!session) return null;

  return (
    <div className="flex flex-col h-full overflow-hidden relative">
      <ExplorerToolbar
        provider={provider}
        currentPath={session.currentPath}
        segments={segments}
        loading={session.loading}
        onNavigate={(path) => void loadDirectory(path)}
        onRefresh={() => void loadDirectory(session.currentPath)}
        onNewFile={() => setCreatingFile(true)}
        onNewFolder={() => setCreatingFolder(true)}
        onUpload={() => void handleUpload()}
        busy={busy}
      />

      {/* Error banner */}
      {session.error && (
        <div className="flex items-center gap-2.5 px-4 py-2.5 bg-status-error/10 border-b border-status-error/20 text-status-error">
          <AlertCircle size={14} strokeWidth={2} aria-hidden="true" className="shrink-0" />
          <p className="text-[length:var(--text-sm)]">{session.error}</p>
        </div>
      )}

      <ExplorerFileTable
        provider={provider}
        entries={explorerEntries}
        sortBy={session.sortBy}
        sortAsc={session.sortAsc}
        onSortChange={(sortBy, sortAsc) => setSort(sftpSessionId, sortBy, sortAsc)}
        clipboard={explorerClipboard}
        onSetClipboard={handleSetClipboard}
        onNavigate={(path) => void loadDirectory(path)}
        onDownload={(entry) => void handleDownload(entry)}
        onDelete={handleDelete}
        onRename={handleRename}
        onEditInEditor={handleEditInEditor}
        creatingFile={creatingFile}
        onCreateFile={(name) => void handleCreateFile(name)}
        onCancelCreateFile={() => setCreatingFile(false)}
        creatingFolder={creatingFolder}
        onCreateFolder={(name) => void handleCreateFolder(name)}
        onCancelCreateFolder={() => setCreatingFolder(false)}
        onPaste={() => void handlePaste()}
        onMoveEntries={handleMoveEntries}
        onCopyEntries={handleCopyEntries}
        loading={session.loading}
        busy={busy}
      />

      {isDragOver && <ExplorerDropZone path={session.currentPath} />}
    </div>
  );
}

// ─── Internal type for Tauri drag-drop event ─────────────────────────────────

interface DragDropEventPayload {
  payload: {
    type: "enter" | "over" | "drop" | "leave";
    paths: string[];
    position?: { x: number; y: number };
  };
}
