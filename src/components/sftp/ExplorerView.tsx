import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertCircle } from "lucide-react";
import { useSftpStore } from "../../stores/sftp-store";
import { useTabStore } from "../../stores/tab-store";
import type { SftpEntry } from "../../types";
import type { ExplorerEntry, ExplorerClipboard } from "../../types/explorer";
import { ExplorerToolbar, ExplorerFileTable, ExplorerDropZone } from "../explorer";
import { createSftpProvider, toExplorerEntry } from "../../providers/sftp-provider";
import { explorerInvoke, transferEventName, type Transport } from "../../lib/explorer-transport";

interface ExplorerViewProps {
  /** The transport session id (sftp_session_id or scp_session_id). */
  sessionId: string;
  /**
   * Which transport backs this view. SCP is selected automatically as a
   * fallback when the host lacks the SFTP subsystem; SFTP and SCP share the
   * same command surface and session store, differing only in dispatch.
   */
  transport?: Transport;
  /** Whether this explorer's tab is currently active/visible. Explorer tabs
   *  stay mounted (issue #17), so document-level listeners are gated to the
   *  active instance to avoid every open explorer reacting to one event. */
  isActive?: boolean;
}

export function ExplorerView({ sessionId, transport = "sftp", isActive = true }: ExplorerViewProps) {
  const session = useSftpStore((s) => s.sessions.get(sessionId));
  const setEntries = useSftpStore((s) => s.setEntries);
  const setLoading = useSftpStore((s) => s.setLoading);
  const setError = useSftpStore((s) => s.setError);
  const setSort = useSftpStore((s) => s.setSort);
  const clipboard = useSftpStore((s) => s.clipboard);
  const setClipboard = useSftpStore((s) => s.setClipboard);
  const sudoMode = useSftpStore((s) => s.sessions.get(sessionId)?.sudoMode ?? false);
  const sshSessionId = useSftpStore((s) => s.sessions.get(sessionId)?.sshSessionId ?? "");
  const swapSession = useSftpStore((s) => s.swapSession);
  const replaceTabId = useTabStore((s) => s.replaceTabId);
  const isRoot = useSftpStore((s) => s.sessions.get(sessionId)?.username === "root");

  const provider = useMemo(() => createSftpProvider(sessionId), [sessionId]);

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
                await explorerInvoke(transport, "enqueue_upload", sessionId, {
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
  }, [sessionId, transport]);

  // ─── Auto-refresh on upload completion ────────────────────────────────────

  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (aborted) return;

        const unsub = await listen<{
          sftp_session_id?: string;
          scp_session_id?: string;
          direction: string;
          status: string;
        }>(transferEventName(transport), (event) => {
          const { direction, status } = event.payload;
          const sid = transport === "scp" ? event.payload.scp_session_id : event.payload.sftp_session_id;
          if (sid === sessionId && direction === "Upload" && status === "Completed") {
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
  }, [sessionId, transport]);

  // ─── Navigation ──────────────────────────────────────────────────────────

  const loadDirectory = useCallback(
    async (path: string) => {
      setLoading(sessionId, true);
      try {
        const entries = await explorerInvoke<SftpEntry[]>(transport, "list_dir", sessionId, { path });
        setEntries(sessionId, path, entries);
      } catch (err: unknown) {
        const msg =
          err && typeof err === "object" && "message" in err
            ? String((err as { message: string }).message)
            : "Failed to list directory";
        setError(sessionId, msg);
      }
    },
    [sessionId, transport, setLoading, setEntries, setError],
  );

  // ─── Sudo toggle (SFTP only) ──────────────────────────────────────────────

  const [togglingSudo, setTogglingSudo] = useState(false);

  const handleToggleSudo = useCallback(async () => {
    // Re-entrancy guard: the open round-trip can take seconds, and a second
    // toggle would open (and orphan) a second server-side SFTP session.
    if (transport !== "sftp" || togglingSudo) return;
    const newSudoMode = !sudoMode;
    setTogglingSudo(true);

    try {
      // 1. Open the new session BEFORE closing the old one.
      const newSftpSessionId = await invoke<string>("sftp_open", {
        sessionId: sshSessionId,
        useSudo: newSudoMode,
      });

      // 2. Close old session on the server (best-effort).
      try { await invoke("sftp_close", { sftpSessionId: sessionId }); } catch { /* ignore */ }

      // 3. Swap the store entry (preserves currentPath so the remount lands
      //    in the same directory).
      swapSession(sessionId, newSftpSessionId, newSudoMode);

      // 4. Update the tab store so AppShell passes the new session ID as prop.
      //    This triggers a React key change → ExplorerView remounts cleanly.
      replaceTabId(sessionId, newSftpSessionId);
    } catch (err: unknown) {
      // Surface the failure (e.g. host without passwordless sudo) instead of
      // silently no-op'ing. The old session is untouched (close runs only
      // after a successful open), so the view keeps working.
      const msg =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : `Failed to ${newSudoMode ? "enable" : "disable"} sudo mode`;
      setError(sessionId, msg);
    } finally {
      // On success the view remounts (tab id changes) and this is a no-op;
      // on failure or a closed tab it re-enables the button.
      setTogglingSudo(false);
    }
  }, [transport, togglingSudo, sudoMode, sessionId, sshSessionId, swapSession, replaceTabId, setError]);

  // On mount: reload the preserved directory (e.g. after a sudo-toggle
  // remount), otherwise resolve the home dir.
  useEffect(() => {
    (async () => {
      const preserved = useSftpStore.getState().sessions.get(sessionId)?.currentPath;
      if (preserved && preserved !== "/") {
        try {
          await loadDirectory(preserved);
          return;
        } catch { /* fall through to home/root */ }
      }
      try {
        const homeDir = await explorerInvoke<string>(transport, "home_dir", sessionId);
        await loadDirectory(homeDir);
      } catch {
        await loadDirectory("/");
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, transport]);

  // ─── Download ─────────────────────────────────────────────────────────────

  const handleDownload = useCallback(async (entry: ExplorerEntry) => {
    try {
      if (entry.entryType === "Directory") {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const localDir = await open({
          directory: true,
          title: `Download "${entry.name}" to…`,
        }) as string | null;
        if (!localDir) return;

        await explorerInvoke(transport, "enqueue_download", sessionId, {
          remotePaths: [entry.id],
          localDir,
        });
      } else {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const savePath = await save({
          defaultPath: entry.name,
          title: `Save "${entry.name}" as…`,
        });
        if (!savePath) return;

        // Use the single-file download API with the full user-chosen path,
        // so a renamed file is saved under the name the user picked.
        await explorerInvoke(transport, "download", sessionId, {
          remotePath: entry.id,
          localPath: savePath,
        });
      }
    } catch (err) {
      console.error("Download failed:", err);
    }
  }, [sessionId, transport]);

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

      await explorerInvoke(transport, "upload", sessionId, { localPath, remotePath });
      void loadDirectory(session.currentPath);
    } catch {
      // Upload errors show in transfer overlay
    }
  }, [sessionId, transport, session, loadDirectory]);

  // ─── New folder/file (inline) ─────────────────────────────────────────────

  const [creatingFolder, setCreatingFolder] = useState(false);
  const [creatingFile, setCreatingFile] = useState(false);

  useEffect(() => {
    // Only the active (visible) explorer should react to the document-level
    // new-folder/new-file events, otherwise every mounted explorer would open
    // an inline create input at once (issue #17 keeps them all mounted).
    if (!isActive) return;
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
  }, [isActive]);

  const handleCreateFile = useCallback(
    async (name: string) => {
      setCreatingFile(false);
      if (!name.trim() || !session) return;
      const filePath = provider.joinPath(session.currentPath, name.trim());
      try {
        await explorerInvoke(transport, "create_file", sessionId, { path: filePath });
        await loadDirectory(session.currentPath);
      } catch {
        // Error shown via refresh
      }
    },
    [sessionId, transport, session, loadDirectory, provider],
  );

  const handleCreateFolder = useCallback(
    async (name: string) => {
      setCreatingFolder(false);
      if (!name.trim() || !session) return;
      const dirPath = provider.joinPath(session.currentPath, name.trim());
      try {
        await explorerInvoke(transport, "mkdir", sessionId, { path: dirPath });
        await loadDirectory(session.currentPath);
      } catch {
        // Error shown via refresh
      }
    },
    [sessionId, transport, session, loadDirectory, provider],
  );

  // ─── Delete ──────────────────────────────────────────────────────────────

  const handleDelete = useCallback(async (entriesToDelete: ExplorerEntry[]) => {
    try {
      for (const entry of entriesToDelete) {
        await explorerInvoke(transport, "delete", sessionId, {
          path: entry.id,
          isDir: entry.entryType === "Directory",
        });
      }
    } catch {
      // Partial deletes may occur
    }
    if (session) void loadDirectory(session.currentPath);
  }, [sessionId, transport, session, loadDirectory]);

  // ─── Rename ──────────────────────────────────────────────────────────────

  const handleRename = useCallback(async (entry: ExplorerEntry, newName: string) => {
    const parentPath = entry.id.substring(0, entry.id.lastIndexOf("/")) || "/";
    const newPath = `${parentPath}/${newName}`;
    try {
      await explorerInvoke(transport, "rename", sessionId, { oldPath: entry.id, newPath });
      if (session) void loadDirectory(session.currentPath);
    } catch (err) {
      console.error("Rename failed:", err);
    }
  }, [sessionId, transport, session, loadDirectory]);

  // ─── Edit in VS Code ─────────────────────────────────────────────────────

  const handleEditInEditor = useCallback((entry: ExplorerEntry) => {
    void (async () => {
      try {
        await explorerInvoke(transport, "edit_in_vscode", sessionId, { remotePath: entry.id });
      } catch {
        // VS Code may not be installed
      }
    })();
  }, [sessionId, transport]);

  // ─── Paste / Move / Copy ─────────────────────────────────────────────────

  const [busy, setBusy] = useState(false);

  const handlePaste = useCallback(async () => {
    const clip = useSftpStore.getState().clipboard;
    if (!clip || clip.sourceSessionId !== sessionId || !session) return;

    const sourcePaths = clip.entries.map((e) => e.path);
    const targetDir = session.currentPath;

    setBusy(true);
    try {
      if (clip.operation === "cut") {
        await explorerInvoke(transport, "move_entries", sessionId, { sourcePaths, targetDir });
        useSftpStore.getState().setClipboard(null);
      } else {
        await explorerInvoke(transport, "copy_entries", sessionId, { sourcePaths, targetDir });
      }
      await loadDirectory(session.currentPath);
    } catch (err) {
      setError(sessionId, err instanceof Error ? err.message : "Paste failed");
    } finally {
      setBusy(false);
    }
  }, [sessionId, transport, session, loadDirectory, setError]);

  const handleMoveEntries = useCallback(async (sourceIds: string[], targetDir: string) => {
    setBusy(true);
    try {
      await explorerInvoke(transport, "move_entries", sessionId, { sourcePaths: sourceIds, targetDir });
      if (session) await loadDirectory(session.currentPath);
    } catch (err) {
      setError(sessionId, err instanceof Error ? err.message : "Move failed");
    } finally {
      setBusy(false);
    }
  }, [sessionId, transport, session, loadDirectory, setError]);

  const handleCopyEntries = useCallback(async (sourceIds: string[], targetDir: string) => {
    setBusy(true);
    try {
      await explorerInvoke(transport, "copy_entries", sessionId, { sourcePaths: sourceIds, targetDir });
      if (session) await loadDirectory(session.currentPath);
    } catch (err) {
      setError(sessionId, err instanceof Error ? err.message : "Copy failed");
    } finally {
      setBusy(false);
    }
  }, [sessionId, transport, session, loadDirectory, setError]);

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
        sudoMode={sudoMode}
        sudoBusy={togglingSudo}
        onToggleSudo={transport === "sftp" && !isRoot ? () => void handleToggleSudo() : undefined}
      />

      {/* Error banner */}
      {session.error && (
        <div
          data-testid="explorer-error"
          className="flex items-center gap-2.5 px-4 py-2.5 bg-status-error/10 border-b border-status-error/20 text-status-error"
        >
          <AlertCircle size={15} strokeWidth={2} aria-hidden="true" className="shrink-0" />
          <p className="text-[length:var(--text-sm)]">{session.error}</p>
        </div>
      )}

      <ExplorerFileTable
        provider={provider}
        entries={explorerEntries}
        sortBy={session.sortBy}
        sortAsc={session.sortAsc}
        onSortChange={(sortBy, sortAsc) => setSort(sessionId, sortBy, sortAsc)}
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
