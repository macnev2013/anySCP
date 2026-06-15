import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertCircle } from "lucide-react";
import { useSftpStore } from "../../stores/sftp-store";
import { useTabStore } from "../../stores/tab-store";
import type { SftpEntry } from "../../types";
import type { ExplorerEntry, ExplorerClipboard, ChmodResult, DragOutResult } from "../../types/explorer";
import { ExplorerToolbar, ExplorerFileTable, ExplorerDropZone } from "../explorer";
import { DropOverwriteDialog } from "./DropOverwriteDialog";
import { createSftpProvider, toExplorerEntry } from "../../providers/sftp-provider";
import { explorerInvoke, transferEventName, type Transport } from "../../lib/explorer-transport";
import { editorLaunchErrorMessage } from "../../lib/editor-errors";
import { conflictingNames } from "../../lib/drop-conflicts";
import { toast } from "../../stores/toast-store";
import type { EditorConfig } from "../../stores/settings-store";

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
  // When the cursor hovers a folder row during an OS drag, this holds that
  // folder's path so files drop INTO it; otherwise it tracks the current dir.
  const [dropTargetDir, setDropTargetDir] = useState<string | null>(null);
  // Set when a drop would overwrite existing remote files, pausing the upload
  // until the user confirms via the dialog.
  const [pendingDrop, setPendingDrop] = useState<PendingDrop | null>(null);
  const isProcessingDrop = useRef(false);
  // True while a drag-OUT we started is in flight (staging + native OS drag).
  // Guards against (a) a re-entrant drag-out re-downloading the same selection
  // and (b) the OS drag re-entering our own window drop listener and
  // re-uploading the just-staged temp files (a self-drop).
  const isDraggingOut = useRef(false);
  const currentPathRef = useRef(session?.currentPath ?? "/");
  currentPathRef.current = session?.currentPath ?? "/";

  // Enqueue dropped local paths for upload, surfacing failures as a toast
  // (the per-file transfer progress/errors still show in the transfer popover).
  const uploadDropped = useCallback(
    async (localPaths: string[], remoteDir: string) => {
      try {
        await explorerInvoke(transport, "enqueue_upload", sessionId, { localPaths, remoteDir });
      } catch (err) {
        toast.error(`Upload failed: ${errorMessage(err)}`);
      }
    },
    [sessionId, transport],
  );

  const confirmOverwrite = useCallback(() => {
    const pd = pendingDrop;
    setPendingDrop(null);
    isProcessingDrop.current = false;
    if (pd) void uploadDropped(pd.localPaths, pd.remoteDir);
  }, [pendingDrop, uploadDropped]);

  const cancelOverwrite = useCallback(() => {
    setPendingDrop(null);
    isProcessingDrop.current = false;
  }, []);

  // Resolve the upload destination for an OS drop/drag at the given window
  // position. Tauri's drag-drop API has no DOM target, so we hit-test the
  // position against the listing: a drop on a directory row uploads into that
  // directory, otherwise into the current directory.
  //
  // Tauri labels the event position `PhysicalPosition`, but only Windows
  // actually reports physical pixels — macOS (wkwebview) and Linux (webkitgtk)
  // already report CSS/logical pixels. `elementFromPoint` wants CSS pixels, so
  // we divide by devicePixelRatio ONLY on Windows; doing so elsewhere would
  // halve the coordinate on HiDPI/Retina and hit the wrong row.
  const resolveDropDir = useCallback(
    (position?: { x: number; y: number }): string => {
      const base = currentPathRef.current;
      if (!position) return base;
      const scale = isWindowsWebview() ? window.devicePixelRatio || 1 : 1;
      const el = document.elementFromPoint(position.x / scale, position.y / scale);
      const row = el?.closest("[data-entry-row]") as HTMLElement | null;
      if (row && row.dataset.entryType === "Directory") {
        const name = row.dataset.entryName;
        const entries = useSftpStore.getState().sessions.get(sessionId)?.entries ?? [];
        const target = entries.find((e) => e.name === name && e.entry_type === "Directory");
        if (target) return target.path;
      }
      return base;
    },
    [sessionId],
  );

  useEffect(() => {
    // Explorer tabs stay mounted (issue #17), so without this guard every open
    // explorer's window-level listener would fire on a single drop and upload
    // the files into every session at once. Only the visible tab listens.
    if (!isActive) return;

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
          // Ignore the OS drag WE started: releasing our own drag-out back over
          // the app must not re-upload the just-staged temp files.
          if (isDraggingOut.current) return;

          const type = event.payload?.type;
          if (type === "enter" || type === "over") {
            setIsDragOver(true);
            setDropTargetDir(resolveDropDir(event.payload?.position));
          } else if (type === "drop") {
            setIsDragOver(false);
            setDropTargetDir(null);

            const paths: string[] = event.payload?.paths ?? [];
            // Backstop for the self-drop guard above: never re-upload our own
            // drag-out staging files even if the in-flight flag was already
            // cleared by the time the OS delivered the drop.
            if (paths.some((p) => p.includes(DRAGOUT_STAGING_SEGMENT))) return;
            if (isProcessingDrop.current || paths.length === 0) return;
            isProcessingDrop.current = true;

            const remoteDir = resolveDropDir(event.payload?.position);

            void (async () => {
              // Pre-flight overwrite check. Best-effort: if the target listing
              // can't be fetched (e.g. permissions) we skip the prompt and let
              // the upload proceed — a real failure surfaces in the popover.
              let conflicts: string[] = [];
              try {
                const existing = await explorerInvoke<SftpEntry[]>(transport, "list_dir", sessionId, { path: remoteDir });
                conflicts = conflictingNames(paths, new Set(existing.map((e) => e.name)));
              } catch {
                // Skip the pre-check; proceed to upload.
              }

              if (conflicts.length > 0) {
                // Hand off to the confirm dialog — it clears the processing
                // guard once the user responds.
                setPendingDrop({ localPaths: paths, remoteDir, conflicts });
                return;
              }

              await uploadDropped(paths, remoteDir);
              setTimeout(() => { isProcessingDrop.current = false; }, 500);
            })();
          } else {
            setIsDragOver(false);
            setDropTargetDir(null);
          }
        });

        if (aborted) { unsub(); } else { unlisten = unsub; }
      } catch {
        // Tauri API not available in browser/test context
      }
    })();

    return () => { aborted = true; unlisten?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, transport, isActive, resolveDropDir, uploadDropped]);

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
        setError(sessionId, errorMessage(err, "Failed to list directory"));
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
      setError(
        sessionId,
        errorMessage(err, `Failed to ${newSudoMode ? "enable" : "disable"} sudo mode`),
      );
    } finally {
      // On success the view remounts (tab id changes) and this is a no-op;
      // on failure or a closed tab it re-enables the button.
      setTogglingSudo(false);
    }
  }, [transport, togglingSudo, sudoMode, sessionId, sshSessionId, swapSession, replaceTabId, setError]);

  // On mount: reload the preserved directory (e.g. after a sudo-toggle
  // remount), otherwise land in the host's configured start directory and
  // fall back to the server home dir, then root.
  useEffect(() => {
    (async () => {
      const sessionState = useSftpStore.getState().sessions.get(sessionId);
      const preserved = sessionState?.currentPath;
      if (preserved && preserved !== "/") {
        await loadDirectory(preserved);
        return;
      }

      // List `path`; on success commit the entries and report true so the
      // caller can stop walking the fallback chain. Unlike loadDirectory this
      // propagates failure instead of surfacing it, so a missing start
      // directory transparently falls through to the home dir.
      const tryList = async (path: string): Promise<boolean> => {
        try {
          const entries = await explorerInvoke<SftpEntry[]>(transport, "list_dir", sessionId, { path });
          setEntries(sessionId, path, entries);
          return true;
        } catch {
          return false;
        }
      };

      // Resolve the home dir lazily — only when the start dir needs `~`
      // expansion or we have to fall back to it.
      let homeDir: string | null = null;
      const resolveHome = async (): Promise<string> => {
        if (homeDir === null) {
          try {
            homeDir = await explorerInvoke<string>(transport, "home_dir", sessionId);
          } catch {
            homeDir = "";
          }
        }
        return homeDir;
      };

      // 1. Configured start directory (with leading-`~` expansion).
      const startDir = (sessionState?.startDirectory ?? "").trim();
      if (startDir) {
        let target: string | null = startDir;
        if (startDir === "~" || startDir.startsWith("~/")) {
          const home = await resolveHome();
          target = !home
            ? null
            : startDir === "~"
              ? home
              : `${home.replace(/\/+$/, "")}/${startDir.slice(2)}`;
        }
        if (target && (await tryList(target))) return;
      }

      // 2. Server home directory. 3. Root.
      const home = await resolveHome();
      if (home && (await tryList(home))) return;
      await loadDirectory("/");
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

  // ─── Drag-out (Explorer → OS desktop/Finder) ──────────────────────────────
  //
  // The whole drag-out runs in the backend `sftp_drag_out` command: it stages
  // every selected entry to a private temp dir (files directly, folders
  // recursively — fixing the old "only one file" bug), then drives the native
  // OS drag with those real local paths and resolves once the drag ends. We
  // must stage *before* the drag because the OS drag API needs concrete file
  // handles up front — see the drag-out comment in ExplorerFileTable for why
  // HTML5 DataTransfer can't do this in a webview.
  //
  // SCP has no `drag_out` command, so drag-out is wired for SFTP only (see the
  // `onDragOut` prop below); SCP sessions keep the in-app move drag.
  //
  // Known limitation: staging a very large folder blocks until every byte is on
  // disk (bounded by a backend size cap), so for big selections the drag may
  // only begin after the mouse is released. The re-entrancy guard below stops a
  // retry from re-downloading the same selection.
  const handleDragOut = useCallback((entries: ExplorerEntry[]) => {
    if (isDraggingOut.current) return; // a drag-out is already staging/dragging
    isDraggingOut.current = true;
    void (async () => {
      // Staging a large selection blocks before the OS drag can attach; show a
      // "Preparing…" toast only if it's slow enough to notice, and clear it once
      // the drag begins/ends.
      let prepToast: string | null = null;
      const prepTimer = setTimeout(() => {
        prepToast = toast.info("Preparing download…");
      }, 400);
      try {
        const remotePaths = entries.map((en) => en.id);
        const { dropped, count } = await explorerInvoke<DragOutResult>(
          transport,
          "drag_out",
          sessionId,
          { remotePaths },
        );
        // The OS copies asynchronously after the drop and gives no completion
        // signal; the backend's drop result is the only success hook, so only
        // confirm when the drag actually dropped (not when it was cancelled).
        if (dropped && count > 0) {
          toast.success(`Downloaded ${count} ${count === 1 ? "item" : "items"}`);
        }
      } catch (err) {
        toast.error(`Download failed: ${errorMessage(err)}`);
      } finally {
        clearTimeout(prepTimer);
        if (prepToast) toast.dismiss(prepToast);
        isDraggingOut.current = false;
      }
    })();
  }, [sessionId, transport]);

  // ─── Upload (dialog) ─────────────────────────────────────────────────────

  const handleUpload = useCallback(async () => {
    if (!session) return;
    try {
      // A plain dynamic import is required here: the dialog plugin's `open`
      // must run inside the module's resolution scope. (An earlier attempt at
      // `Function("s","return import(s)")` resolved the bare specifier against
      // the document base URL, threw, and silently fell back to a no-op
      // `window.prompt` in the macOS webview — see issue #69.)
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selection = await open({ multiple: true, title: "Upload file" });
      if (!selection) return;
      const localPaths = Array.isArray(selection) ? selection : [selection];
      if (localPaths.length === 0) return;

      // Route through the transfer queue (same path as drag-and-drop): it
      // walks directories, reports progress in the transfer overlay, and the
      // completion listener above refreshes the listing once each file lands.
      await explorerInvoke(transport, "enqueue_upload", sessionId, {
        localPaths,
        remoteDir: session.currentPath,
      });
    } catch {
      // Upload errors surface in the transfer overlay
    }
  }, [sessionId, transport, session]);

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

  // ─── Change permissions (chmod) ─────────────────────────────────────────────

  const handleApplyPermissions = useCallback(async (entry: ExplorerEntry, mode: number, recursive: boolean) => {
    let result: ChmodResult | undefined;
    if (recursive && entry.entryType === "Directory") {
      result = await explorerInvoke<ChmodResult>(transport, "chmod_recursive", sessionId, { path: entry.id, mode });
    } else {
      await explorerInvoke(transport, "chmod", sessionId, { path: entry.id, mode });
    }
    // The chmod has already succeeded here. Refresh the listing best-effort: a
    // reload failure (e.g. a dropped connection) must NOT propagate as a chmod
    // error, or the user would be told it failed and retry an applied change.
    const refreshPath = session?.currentPath;
    if (refreshPath !== undefined) {
      try {
        await loadDirectory(refreshPath);
      } catch (err) {
        console.error("Directory refresh after chmod failed:", err);
      }
    }
    return result;
  }, [sessionId, transport, session, loadDirectory]);

  // ─── Edit in external editor ───────────────────────────────────────────────

  const handleEditInEditor = useCallback((entry: ExplorerEntry, editor?: EditorConfig) => {
    void (async () => {
      try {
        await explorerInvoke(transport, "edit_external", sessionId, {
          remotePath: entry.id,
          editor: editor ?? null,
        });
      } catch (err) {
        toast.error(editorLaunchErrorMessage(err));
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
        permissions: e.permissions ?? 0,
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
        onApplyPermissions={handleApplyPermissions}
        creatingFile={creatingFile}
        onCreateFile={(name) => void handleCreateFile(name)}
        onCancelCreateFile={() => setCreatingFile(false)}
        creatingFolder={creatingFolder}
        onCreateFolder={(name) => void handleCreateFolder(name)}
        onCancelCreateFolder={() => setCreatingFolder(false)}
        onPaste={() => void handlePaste()}
        onMoveEntries={handleMoveEntries}
        onCopyEntries={handleCopyEntries}
        onDragOut={transport === "sftp" ? handleDragOut : undefined}
        currentPath={session.currentPath}
        loading={session.loading}
        busy={busy}
      />

      {isDragOver && (
        <ExplorerDropZone
          path={dropTargetDir ?? session.currentPath}
          intoFolder={!!dropTargetDir && dropTargetDir !== session.currentPath}
        />
      )}

      {pendingDrop && (
        <DropOverwriteDialog
          conflicts={pendingDrop.conflicts}
          targetDir={pendingDrop.remoteDir}
          onConfirm={confirmOverwrite}
          onCancel={cancelOverwrite}
        />
      )}
    </div>
  );
}

// ─── Drag-drop overwrite confirmation ────────────────────────────────────────

interface PendingDrop {
  localPaths: string[];
  remoteDir: string;
  conflicts: string[];
}

/** Extract a human-readable message from a Tauri/SftpError rejection. */
function errorMessage(err: unknown, fallback = "Unexpected error"): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: string }).message);
  }
  return typeof err === "string" ? err : fallback;
}

/** Path segment of our drag-out staging dir (temp_dir/anyscp-dragout/<uuid>). */
const DRAGOUT_STAGING_SEGMENT = "anyscp-dragout";

/**
 * Whether the webview is running on Windows. Tauri's drag-drop event position
 * is physical pixels only on Windows; macOS/Linux report CSS pixels despite the
 * `PhysicalPosition` label, so HiDPI hit-testing must scale only here.
 */
function isWindowsWebview(): boolean {
  return typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent);
}

// ─── Internal type for Tauri drag-drop event ─────────────────────────────────

interface DragDropEventPayload {
  payload: {
    type: "enter" | "over" | "drop" | "leave";
    paths: string[];
    position?: { x: number; y: number };
  };
}
