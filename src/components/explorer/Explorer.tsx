import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertCircle } from "lucide-react";
import { useSftpStore } from "../../stores/sftp-store";
import { useTabStore } from "../../stores/tab-store";
import { usePaneState } from "../../hooks/use-pane-state";
import type {
  ExplorerEntry,
  ExplorerClipboard,
  ChmodResult,
  FileSystemProvider,
  PaneRuntime,
  CrossPaneTarget,
} from "../../types/explorer";
import { ExplorerToolbar } from "./ExplorerToolbar";
import { ExplorerFileTable } from "./ExplorerFileTable";
import { ExplorerDropZone } from "./ExplorerDropZone";
import { DropOverwriteDialog } from "../sftp/DropOverwriteDialog";
import { conflictingNames } from "../../lib/drop-conflicts";
import { closestAtPoint } from "../../lib/hit-test";
import { editorLaunchErrorMessage } from "../../lib/editor-errors";
import { toast } from "../../stores/toast-store";
import type { EditorConfig } from "../../stores/settings-store";

interface ExplorerProps {
  /** The backend adapter — one container drives SFTP/SCP and S3 through it. */
  provider: FileSystemProvider;
  /** Whether this pane is the active/focused one. Explorer tabs stay mounted
   *  (issue #17), so document-level listeners are gated to the active one. In
   *  dual-pane only the focused pane is active. */
  isActive?: boolean;
  /** Whether this pane's TAB is visible (both panes of a dual-pane tab are
   *  "tab-active" even though only one is focused). Gates the window-global OS
   *  drop listener so the non-focused pane can still receive drops that land
   *  over it. Defaults to `isActive` for single-pane callers. */
  tabActive?: boolean;
  /** Register this pane's runtime with the dual-pane coordinator so the sibling
   *  pane can transfer files into it. Passed only in dual-pane mode. */
  registerRuntime?: (runtime: PaneRuntime | null) => void;
  /** The sibling pane, enabling "Copy to <sibling>" context actions. */
  crossPane?: CrossPaneTarget;
  /** This pane is part of a split (dual-pane). Keeps the listing compact (short
   *  date) since space is tight; a single pane can show the full date+time. */
  dense?: boolean;
}

/**
 * The single file-explorer container. All backend calls go through `provider`;
 * per-pane browsing state comes from `usePaneState`. Backend-specific bits are
 * gated by capabilities or provider type (sudo → SFTP; presign → S3).
 */
export function Explorer({
  provider,
  isActive = true,
  tabActive,
  registerRuntime,
  crossPane,
  dense,
}: ExplorerProps) {
  // A dual-pane's non-focused pane is still tab-visible; single-pane callers
  // that don't pass tabActive fall back to isActive.
  const isTabActive = tabActive ?? isActive;
  const sessionId = provider.sessionId;
  const caps = provider.capabilities;
  const isSftpLike = provider.type === "sftp" || provider.type === "scp";
  const pane = usePaneState(provider);

  const currentPathRef = useRef(pane.currentPath);
  currentPathRef.current = pane.currentPath;
  // Read the listing through a ref inside stable callbacks (e.g. resolveDropDir)
  // so their identity doesn't change every refresh and re-subscribe the
  // window-global drag-drop listener.
  const entriesRef = useRef(pane.entries);
  entriesRef.current = pane.entries;

  // ─── Navigation ────────────────────────────────────────────────────────────

  const loadDirectory = useCallback(
    async (path: string) => {
      pane.setLoading(true);
      try {
        pane.setEntries(path, await provider.listDir(path));
      } catch (err) {
        pane.setError(errorMessage(err, "Failed to list directory"));
      }
    },
    // pane's setters are recreated each render but the effects/handlers that
    // matter gate on sessionId; see eslint-disable notes below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [provider],
  );

  // ─── Drag-and-drop (OS → App) ─────────────────────────────────────────────

  const [isDragOver, setIsDragOver] = useState(false);
  const [dropTargetDir, setDropTargetDir] = useState<string | null>(null);
  const [pendingDrop, setPendingDrop] = useState<PendingDrop | null>(null);
  const isProcessingDrop = useRef(false);
  const isDraggingOut = useRef(false);

  const uploadDropped = useCallback(
    async (localPaths: string[], remoteDir: string, onEnqueued?: (ids: string[]) => void) => {
      try {
        const ids = await provider.enqueueUpload?.(localPaths, remoteDir);
        if (ids) onEnqueued?.(ids);
      } catch (err) {
        toast.error(`Upload failed: ${errorMessage(err)}`);
      }
    },
    [provider],
  );

  // Destination overwrite guard shared by uploads (into a remote dir) and
  // cross-pane downloads (into the local dir): pre-check `dir` for name
  // collisions and, if any, pause on the overwrite dialog instead of silently
  // clobbering; otherwise run `proceed`. Returns true when it paused. Works for
  // every backend via `provider.listDir`.
  const guardOverwrite = useCallback(
    async (dir: string, names: string[], proceed: () => void | Promise<void>): Promise<boolean> => {
      let conflicts: string[] = [];
      try {
        const existing = await provider.listDir(dir);
        conflicts = conflictingNames(names, new Set(existing.map((e) => e.name)));
      } catch {
        // Can't read the dir (e.g. permissions) — skip the pre-check and let the
        // transfer proceed; a real failure surfaces in the transfer popover.
      }
      if (conflicts.length > 0) {
        setPendingDrop({ conflicts, targetDir: dir, proceed: () => void proceed() });
        return true;
      }
      await proceed();
      return false;
    },
    [provider],
  );

  // The one upload path for both the toolbar dialog and OS drag-drop.
  const startUpload = useCallback(
    async (localPaths: string[], targetDir: string, onEnqueued?: (ids: string[]) => void): Promise<boolean> => {
      if (!provider.enqueueUpload || localPaths.length === 0) return false;
      return guardOverwrite(targetDir, localPaths, () => uploadDropped(localPaths, targetDir, onEnqueued));
    },
    [provider, uploadDropped, guardOverwrite],
  );

  // remote → local cross-pane download: the local pane owns the destination, so
  // it runs the same conflict pre-check as an upload before letting the remote
  // pane enqueue the download into the resolved local dir.
  const receiveDownload = useCallback(
    async (entries: ExplorerEntry[], run: (localDir: string) => void, targetDir?: string) => {
      const localDir = targetDir ?? currentPathRef.current;
      await guardOverwrite(localDir, entries.map((e) => e.id), () => run(localDir));
    },
    [guardOverwrite],
  );

  const confirmOverwrite = useCallback(() => {
    const pd = pendingDrop;
    setPendingDrop(null);
    isProcessingDrop.current = false;
    pd?.proceed();
  }, [pendingDrop]);

  const cancelOverwrite = useCallback(() => {
    setPendingDrop(null);
    isProcessingDrop.current = false;
  }, []);

  // Resolve the upload destination for an OS drop: hit-test the window position
  // against the listing so a drop on a folder row uploads INTO that folder.
  const resolveDropDir = useCallback(
    (position?: { x: number; y: number }): string => {
      const base = currentPathRef.current;
      if (!position) return base;
      const scale = isWindowsWebview() ? window.devicePixelRatio || 1 : 1;
      const row = closestAtPoint(position.x / scale, position.y / scale, "[data-entry-row]");
      if (row && row.dataset.entryType === "Directory") {
        const name = row.dataset.entryName;
        const target = entriesRef.current.find((e) => e.name === name && e.entryType === "Directory");
        if (target) return target.id;
      }
      return base;
    },
    [],
  );

  // The OS drop event is window-global, so in a dual-pane both panes hear every
  // drop. Each pane claims only the drops that land over its own DOM (tagged
  // with data-explorer-pane-key) so files go to the pane you dropped on, not
  // whichever happens to be focused. When the platform omits a position, fall
  // back to the focused pane.
  const isOverThisPane = useCallback(
    (position?: { x: number; y: number }): boolean => {
      if (!position) return isActive;
      const scale = isWindowsWebview() ? window.devicePixelRatio || 1 : 1;
      const paneEl = closestAtPoint(position.x / scale, position.y / scale, "[data-explorer-pane-key]");
      return paneEl?.dataset.explorerPaneKey === sessionId;
    },
    [isActive, sessionId],
  );

  // Perform an OS drop into `targetDir`: remote panes upload (with the
  // conflict/overwrite guard); the local pane copies the dropped paths in place
  // (they're already local), de-duping so nothing is clobbered. Returns true
  // when the overwrite dialog is now in control (upload only).
  const performDrop = useCallback(
    async (localPaths: string[], targetDir: string): Promise<boolean> => {
      if (provider.enqueueUpload) return startUpload(localPaths, targetDir);
      if (provider.copy) {
        try {
          await provider.copy(localPaths, targetDir);
          await loadDirectory(currentPathRef.current);
        } catch (err) {
          toast.error(`Copy failed: ${errorMessage(err)}`);
        }
      }
      return false;
    },
    [provider, startUpload, loadDirectory],
  );

  useEffect(() => {
    if (!isTabActive || !caps.canDragDropUpload) return;
    if (!provider.enqueueUpload && !provider.copy) return;

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
          } catch { /* Drag-drop API unavailable */ }
        }
        if (!appWindow || aborted) return;

        const unsub = await appWindow.onDragDropEvent((event: DragDropEventPayload) => {
          if (isDraggingOut.current) return;
          const type = event.payload?.type;
          // Only claim events whose cursor is over THIS pane; otherwise make
          // sure our own overlay is cleared (the sibling pane will show its own).
          const overSelf = isOverThisPane(event.payload?.position);
          if (type === "enter" || type === "over") {
            if (overSelf) {
              setIsDragOver(true);
              setDropTargetDir(resolveDropDir(event.payload?.position));
            } else {
              setIsDragOver(false);
              setDropTargetDir(null);
            }
          } else if (type === "drop") {
            setIsDragOver(false);
            setDropTargetDir(null);
            if (!overSelf) return;
            const paths: string[] = event.payload?.paths ?? [];
            if (paths.some((p) => p.includes(DRAGOUT_STAGING_SEGMENT))) return;
            if (isProcessingDrop.current || paths.length === 0) return;
            isProcessingDrop.current = true;
            const targetDir = resolveDropDir(event.payload?.position);

            void performDrop(paths, targetDir).then((deferred) => {
              // When deferred, the overwrite dialog owns the guard (reset by
              // confirm/cancel); otherwise clear it once the drop is handled.
              if (!deferred) setTimeout(() => { isProcessingDrop.current = false; }, 500);
            });
          } else {
            setIsDragOver(false);
            setDropTargetDir(null);
          }
        });

        if (aborted) { unsub(); } else { unlisten = unsub; }
      } catch { /* Tauri API not available */ }
    })();

    return () => { aborted = true; unlisten?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, isTabActive, isOverThisPane, resolveDropDir, performDrop]);

  // ─── Auto-refresh on upload completion ────────────────────────────────────

  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | undefined;
    const sessionField = `${provider.type}_session_id`;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (aborted) return;
        const unsub = await listen<Record<string, string>>(`${provider.type}:transfer`, (event) => {
          const p = event.payload;
          if (p[sessionField] === sessionId && p.direction === "Upload" && p.status === "Completed") {
            setTimeout(() => {
              const path = currentPathRef.current;
              if (path !== undefined) void loadDirectory(path);
            }, 300);
          }
        });
        if (aborted) { unsub(); } else { unlisten = unsub; }
      } catch { /* Not in Tauri context */ }
    })();
    return () => { aborted = true; unlisten?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, provider.type]);

  // ─── Sudo toggle (SFTP only) ──────────────────────────────────────────────

  const sudoMode = useSftpStore((s) => s.sessions.get(sessionId)?.sudoMode ?? false);
  const sshSessionId = useSftpStore((s) => s.sessions.get(sessionId)?.sshSessionId ?? "");
  const isRoot = useSftpStore((s) => s.sessions.get(sessionId)?.username === "root");
  const swapSession = useSftpStore((s) => s.swapSession);
  const replaceTabId = useTabStore((s) => s.replaceTabId);
  const [togglingSudo, setTogglingSudo] = useState(false);

  const handleToggleSudo = useCallback(async () => {
    if (provider.type !== "sftp" || togglingSudo) return;
    const newSudoMode = !sudoMode;
    setTogglingSudo(true);
    try {
      const newSftpSessionId = await invoke<string>("sftp_open", { sessionId: sshSessionId, useSudo: newSudoMode });
      try { await invoke("sftp_close", { sftpSessionId: sessionId }); } catch { /* ignore */ }
      swapSession(sessionId, newSftpSessionId, newSudoMode);
      replaceTabId(sessionId, newSftpSessionId);
    } catch (err) {
      pane.setError(errorMessage(err, `Failed to ${newSudoMode ? "enable" : "disable"} sudo mode`));
    } finally {
      setTogglingSudo(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.type, togglingSudo, sudoMode, sessionId, sshSessionId, swapSession, replaceTabId]);

  // ─── Mount: resolve the starting directory ─────────────────────────────────

  useEffect(() => {
    (async () => {
      // SFTP "/" means "unresolved" → walk the start-dir → home → root chain.
      // S3's "" is the real root and is loaded directly.
      if (isSftpLike) {
        const state = useSftpStore.getState().sessions.get(sessionId);
        const preserved = state?.currentPath;
        if (preserved && preserved !== "/") { await loadDirectory(preserved); return; }

        const tryList = async (path: string): Promise<boolean> => {
          try { pane.setEntries(path, await provider.listDir(path)); return true; } catch { return false; }
        };
        let homeDir: string | null = null;
        const resolveHome = async (): Promise<string> => {
          if (homeDir === null) { try { homeDir = await provider.homeDir(); } catch { homeDir = ""; } }
          return homeDir;
        };

        const startDir = (state?.startDirectory ?? "").trim();
        if (startDir) {
          let target: string | null = startDir;
          if (startDir === "~" || startDir.startsWith("~/")) {
            const home = await resolveHome();
            target = !home ? null : startDir === "~" ? home : `${home.replace(/\/+$/, "")}/${startDir.slice(2)}`;
          }
          if (target && (await tryList(target))) return;
        }
        const home = await resolveHome();
        if (home && (await tryList(home))) return;
        await loadDirectory("/");
      } else {
        const preserved = currentPathRef.current;
        await loadDirectory(preserved || (await safeHome(provider)));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, provider.type]);

  // ─── Download ──────────────────────────────────────────────────────────────

  // Ask for a destination folder once and queue the whole selection into it
  // under their original names. Shared by the single-directory download and the
  // multi-selection download.
  const downloadInto = useCallback(async (entries: ExplorerEntry[], title: string) => {
    if (!provider.enqueueDownload || entries.length === 0) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const localDir = (await open({ directory: true, title })) as string | null;
      if (!localDir) return;
      await provider.enqueueDownload(entries.map((e) => e.id), localDir);
    } catch (err) {
      console.error("Download failed:", err);
    }
  }, [provider]);

  const handleDownload = useCallback(async (entry: ExplorerEntry) => {
    // A folder can only go into a chosen directory; a file gets a Save-as dialog
    // so it can be renamed on the way down.
    if (entry.entryType === "Directory") {
      await downloadInto([entry], `Download "${entry.name}" to…`);
      return;
    }
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const savePath = await save({ defaultPath: entry.name, title: `Save "${entry.name}" as…` });
      if (!savePath) return;
      await provider.downloadAs?.(entry, savePath);
    } catch (err) {
      console.error("Download failed:", err);
    }
  }, [provider, downloadInto]);

  const handleDownloadMany = useCallback(
    (entries: ExplorerEntry[]) => downloadInto(entries, `Download ${entries.length} items to…`),
    [downloadInto],
  );

  // ─── Dual-pane coordinator registration ───────────────────────────────────
  // Expose this pane's cwd + transfer entry points so the sibling can copy files
  // across. Upload/download run on whichever pane's provider implements them.
  // Registers once per mount — cwd is read live from the ref.
  useEffect(() => {
    if (!registerRuntime) return;
    const runtime: PaneRuntime = {
      getCurrentPath: () => currentPathRef.current,
      refresh: () => void loadDirectory(currentPathRef.current),
      uploadInto: provider.enqueueUpload
        ? (localPaths, onEnqueued, targetDir) =>
            void startUpload(localPaths, targetDir ?? currentPathRef.current, onEnqueued)
        : undefined,
      downloadTo: provider.enqueueDownload
        ? (entries, localDir, onEnqueued) =>
            void provider
              .enqueueDownload!(entries.map((e) => e.id), localDir)
              .then((ids) => onEnqueued?.(ids))
              .catch((err) => console.error("Download failed:", err))
        : undefined,
      receiveDownload: (entries, run, targetDir) => void receiveDownload(entries, run, targetDir),
      remove: (entries) =>
        void (async () => {
          try {
            for (const entry of entries) await provider.delete(entry);
          } catch (err) {
            pane.setError(err instanceof Error ? err.message : "Delete failed");
          }
          await loadDirectory(currentPathRef.current);
        })(),
      clearClipboard: () => pane.setClipboard(null),
    };
    registerRuntime(runtime);
    return () => registerRuntime(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerRuntime, provider, startUpload, loadDirectory, receiveDownload]);

  // ─── Drag-out (Explorer → OS) ───────────────────────────────────────────────

  const handleDragOut = useCallback((entries: ExplorerEntry[]) => {
    if (isDraggingOut.current || !provider.dragOut) return;
    // SFTP/SCP drag-out must download every byte to a temp dir before the OS
    // drag can begin (remote files aren't local). For a large file — or any
    // directory, whose recursive size we can't know cheaply — that staging
    // blocks well past the drag gesture and looks like a hang, so route those to
    // the normal download flow (progress + cancel). Local drag-out streams the
    // real on-disk paths with no staging, so it's never gated.
    if (isSftpLike) {
      const totalBytes = entries.reduce((sum, e) => sum + (e.size ?? 0), 0);
      const hasDir = entries.some((e) => e.entryType === "Directory");
      if (hasDir || totalBytes > DRAGOUT_STAGE_MAX_BYTES) {
        toast.info("Large item — downloading to a folder you pick instead of drag-and-drop.");
        const title =
          entries.length === 1
            ? `Download "${entries[0].name}" to…`
            : `Download ${entries.length} items to…`;
        void downloadInto(entries, title);
        return;
      }
    }
    isDraggingOut.current = true;
    void (async () => {
      let prepToast: string | null = null;
      const prepTimer = setTimeout(() => { prepToast = toast.info("Preparing download…"); }, 400);
      try {
        const { dropped, count } = await provider.dragOut!(entries.map((e) => e.id));
        if (dropped && count > 0) toast.success(`Downloaded ${count} ${count === 1 ? "item" : "items"}`);
      } catch (err) {
        toast.error(`Download failed: ${errorMessage(err)}`);
      } finally {
        clearTimeout(prepTimer);
        if (prepToast) toast.dismiss(prepToast);
        isDraggingOut.current = false;
      }
    })();
  }, [provider, isSftpLike, downloadInto]);

  // ─── Upload (dialog) ─────────────────────────────────────────────────────

  const handleUpload = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selection = await open({ multiple: true, title: "Upload file" });
      if (!selection) return;
      const localPaths = Array.isArray(selection) ? selection : [selection];
      // Same path as drag-drop: pre-checks conflicts and confirms before overwrite.
      await startUpload(localPaths, currentPathRef.current);
    } catch { /* Upload errors surface in the transfer overlay */ }
  }, [startUpload]);

  // Upload one or more whole folders. The picker is folder-only
  // (`directory: true`), returning the selected folder paths themselves — the
  // backend's enqueue_upload recreates each folder remotely and walks it
  // recursively, so it goes through the same conflict/overwrite + queue path as
  // file upload and drag-drop.
  const handleUploadFolder = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selection = await open({ directory: true, multiple: true, title: "Upload folder" });
      if (!selection) return;
      const localPaths = Array.isArray(selection) ? selection : [selection];
      await startUpload(localPaths, currentPathRef.current);
    } catch { /* Upload errors surface in the transfer overlay */ }
  }, [startUpload]);

  // ─── New folder/file (inline) ─────────────────────────────────────────────

  const [creatingFolder, setCreatingFolder] = useState(false);
  const [creatingFile, setCreatingFile] = useState(false);

  useEffect(() => {
    if (!isTabActive) return;
    // A new-file/folder event with a detail.paneKey is claimed only by that
    // pane; an untargeted event (e.g. a future global hotkey) falls back to the
    // focused pane.
    const claims = (e: Event): boolean => {
      const key = (e as CustomEvent<{ paneKey?: string }>).detail?.paneKey;
      return key ? key === sessionId : isActive;
    };
    const folderHandler = (e: Event) => { if (claims(e)) setCreatingFolder(true); };
    const fileHandler = (e: Event) => { if (claims(e)) setCreatingFile(true); };
    document.addEventListener("explorer:new-folder", folderHandler);
    document.addEventListener("explorer:new-file", fileHandler);
    return () => {
      document.removeEventListener("explorer:new-folder", folderHandler);
      document.removeEventListener("explorer:new-file", fileHandler);
    };
  }, [isTabActive, isActive, sessionId]);

  // Whether a same-dir name already exists in the current listing. Guards create
  // and rename against silent overwrites: `create_file` truncates and POSIX
  // `rename` clobbers, so the backend won't error — we have to catch it here.
  // Only simple names are checked; a nested path (a/b.txt) targets another dir.
  const nameTaken = useCallback(
    (name: string, excludeId?: string) =>
      !name.includes("/") && pane.entries.some((e) => e.name === name && e.id !== excludeId),
    [pane.entries],
  );

  // Create a file or folder in the current dir, refresh, and surface any backend
  // failure — e.g. a name that collides with an existing entry.
  const createEntry = useCallback(
    async (name: string, create: (path: string) => Promise<void>, kind: "file" | "folder") => {
      const trimmed = name.trim();
      if (!trimmed) return;
      if (nameTaken(trimmed)) {
        toast.error(`An item named "${trimmed}" already exists`);
        return;
      }
      try {
        await create(provider.joinPath(currentPathRef.current, trimmed));
        await loadDirectory(currentPathRef.current);
      } catch (err) {
        toast.error(`Couldn't create ${kind} "${trimmed}": ${errorMessage(err)}`);
      }
    },
    [provider, loadDirectory, nameTaken],
  );

  const handleCreateFile = useCallback((name: string) => {
    setCreatingFile(false);
    void createEntry(name, (path) => provider.createFile(path), "file");
  }, [provider, createEntry]);

  const handleCreateFolder = useCallback((name: string) => {
    setCreatingFolder(false);
    void createEntry(name, (path) => provider.mkdir(path), "folder");
  }, [provider, createEntry]);

  // ─── Delete / Rename / Permissions / Editor ────────────────────────────────

  const handleDelete = useCallback(async (entriesToDelete: ExplorerEntry[]) => {
    // Delete each independently so one failure doesn't skip the rest; surface a
    // summary rather than swallowing it.
    const failed: string[] = [];
    for (const entry of entriesToDelete) {
      try {
        await provider.delete(entry);
      } catch {
        failed.push(entry.name);
      }
    }
    if (failed.length === 1) toast.error(`Couldn't delete "${failed[0]}"`);
    else if (failed.length > 1) toast.error(`Couldn't delete ${failed.length} items`);
    void loadDirectory(currentPathRef.current);
  }, [provider, loadDirectory]);

  const handleRename = useCallback(async (entry: ExplorerEntry, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === entry.name) return;
    if (nameTaken(trimmed, entry.id)) {
      toast.error(`An item named "${trimmed}" already exists`);
      return;
    }
    try {
      await provider.rename?.(entry, provider.joinPath(provider.parentPath(entry.id), trimmed));
      void loadDirectory(currentPathRef.current);
    } catch (err) {
      toast.error(`Rename failed: ${errorMessage(err)}`);
    }
  }, [provider, loadDirectory, nameTaken]);

  const handleApplyPermissions = useCallback(async (entry: ExplorerEntry, mode: number, recursive: boolean) => {
    const result = await provider.chmod?.(entry, mode, recursive);
    try { await loadDirectory(currentPathRef.current); } catch (err) { console.error("Refresh after chmod failed:", err); }
    return result as ChmodResult | undefined;
  }, [provider, loadDirectory]);

  const handleEditInEditor = useCallback((entry: ExplorerEntry, editor?: EditorConfig) => {
    void (async () => {
      try {
        await provider.editInEditor?.(entry, editor ?? null);
      } catch (err) {
        toast.error(editorLaunchErrorMessage(err));
      }
    })();
  }, [provider]);

  const handlePresignUrl = useCallback(async (entry: ExplorerEntry) => {
    try {
      const url = await provider.presignUrl?.(entry);
      if (url) await navigator.clipboard.writeText(url);
    } catch { /* best-effort */ }
  }, [provider]);

  // ─── Paste / Move / Copy ─────────────────────────────────────────────────

  const [busy, setBusy] = useState(false);

  // Run a mutating op behind the busy spinner, refreshing the listing after and
  // surfacing failures. Shared by paste, drag-move, and drag-copy.
  const runBusy = useCallback(async (op: () => Promise<void>, errLabel: string) => {
    setBusy(true);
    try {
      await op();
      await loadDirectory(currentPathRef.current);
    } catch (err) {
      pane.setError(err instanceof Error ? err.message : errLabel);
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadDirectory]);

  const handlePaste = useCallback(() => {
    // Cross-pane paste: if the most-recent copy was in the sibling pane, pull it
    // across (upload/download into this pane's cwd) instead of a same-pane copy.
    if (crossPane?.pasteFromSibling()) return;
    const clip = pane.clipboard;
    if (!clip || clip.sourceSessionId !== sessionId) return;
    const sourceIds = clip.entries.map((e) => e.id);
    void runBusy(async () => {
      if (clip.operation === "cut") {
        await provider.move?.(sourceIds, currentPathRef.current);
        pane.setClipboard(null);
      } else {
        await provider.copy?.(sourceIds, currentPathRef.current);
      }
    }, "Paste failed");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, sessionId, pane.clipboard, runBusy, crossPane]);

  // Mirror every clipboard change into the shared cross-pane slot so a ⌘V in the
  // sibling pane can pull a copy across; a cut/clear empties the shared slot
  // (cut is same-pane only, and a stale copy must not hijack a later paste).
  const handleSetClipboard = useCallback((c: ExplorerClipboard | null) => {
    pane.setClipboard(c);
    crossPane?.syncClipboard(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crossPane]);

  const handleMoveEntries = useCallback(
    (sourceIds: string[], targetDir: string) =>
      runBusy(async () => { await provider.move?.(sourceIds, targetDir); }, "Move failed"),
    [provider, runBusy],
  );

  const handleCopyEntries = useCallback(
    (sourceIds: string[], targetDir: string) =>
      runBusy(async () => { await provider.copy?.(sourceIds, targetDir); }, "Copy failed"),
    [provider, runBusy],
  );

  // ─── Render ────────────────────────────────────────────────────────────────

  const segments = provider.breadcrumbs(pane.currentPath);

  return (
    <div
      // `@container`: the file table's columns respond to THIS pane's width (not
      // the viewport), so a narrowed dual-pane minifies its own columns.
      className="@container flex flex-col h-full overflow-hidden relative"
      // Identifies this pane for cross-pane drag: a drop that lands over a
      // sibling pane (different key) routes to the transfer coordinator.
      data-explorer-pane-key={sessionId}
    >
      <ExplorerToolbar
        provider={provider}
        currentPath={pane.currentPath}
        segments={segments}
        loading={pane.loading}
        onNavigate={(path) => void loadDirectory(path)}
        onRefresh={() => void loadDirectory(pane.currentPath)}
        onNewFile={() => setCreatingFile(true)}
        onNewFolder={() => setCreatingFolder(true)}
        onUpload={() => void handleUpload()}
        onUploadFolder={() => void handleUploadFolder()}
        busy={busy}
        sudoMode={sudoMode}
        sudoBusy={togglingSudo}
        onToggleSudo={provider.type === "sftp" && !isRoot ? () => void handleToggleSudo() : undefined}
      />

      {pane.error && (
        <div
          data-testid="explorer-error"
          className="flex items-center gap-2.5 px-4 py-2.5 bg-status-error/10 border-b border-status-error/20 text-status-error"
        >
          <AlertCircle size={15} strokeWidth={2} aria-hidden="true" className="shrink-0" />
          {/* Single-line + truncate so a long message (e.g. "Remote I/O error:
              connection closed") doesn't wrap and grow the banner in a narrow
              pane; the full text is available on hover. */}
          <p className="text-[length:var(--text-sm)] min-w-0 truncate" title={pane.error}>
            {pane.error}
          </p>
        </div>
      )}

      <ExplorerFileTable
        provider={provider}
        entries={pane.entries}
        sortBy={pane.sortBy}
        sortAsc={pane.sortAsc}
        onSortChange={(sortBy, sortAsc) => pane.setSort(sortBy, sortAsc)}
        clipboard={pane.clipboard}
        onSetClipboard={handleSetClipboard}
        onNavigate={(path) => void loadDirectory(path)}
        onDownload={(entry) => void handleDownload(entry)}
        onDownloadMany={provider.enqueueDownload ? (entries) => void handleDownloadMany(entries) : undefined}
        onDelete={handleDelete}
        onRename={caps.canRename ? handleRename : undefined}
        onEditInEditor={caps.canEditInEditor ? handleEditInEditor : undefined}
        onApplyPermissions={caps.hasPermissions && provider.chmod ? handleApplyPermissions : undefined}
        onPresignUrl={caps.canPresignUrl ? (entry) => void handlePresignUrl(entry) : undefined}
        creatingFile={creatingFile}
        onCreateFile={(name) => void handleCreateFile(name)}
        onCancelCreateFile={() => setCreatingFile(false)}
        creatingFolder={creatingFolder}
        onCreateFolder={(name) => void handleCreateFolder(name)}
        onCancelCreateFolder={() => setCreatingFolder(false)}
        onPaste={caps.canCopyPaste || crossPane ? () => void handlePaste() : undefined}
        onMoveEntries={caps.canInternalDragMove ? handleMoveEntries : undefined}
        onCopyEntries={caps.canCopyPaste ? handleCopyEntries : undefined}
        onDragOut={provider.dragOut ? handleDragOut : undefined}
        crossPane={crossPane}
        currentPath={pane.currentPath}
        loading={pane.loading}
        busy={busy}
        dense={dense}
      />

      {isDragOver && (
        <ExplorerDropZone
          path={dropTargetDir ?? pane.currentPath}
          intoFolder={!!dropTargetDir && dropTargetDir !== pane.currentPath}
          action={provider.enqueueUpload ? "upload" : "copy"}
        />
      )}

      {pendingDrop && (
        <DropOverwriteDialog
          conflicts={pendingDrop.conflicts}
          targetDir={pendingDrop.targetDir}
          onConfirm={confirmOverwrite}
          onCancel={cancelOverwrite}
        />
      )}
    </div>
  );
}

interface PendingDrop {
  conflicts: string[];
  /** Destination directory shown in the dialog. */
  targetDir: string;
  /** Run the transfer the user confirmed (upload or cross-pane download). */
  proceed: () => void;
}

/** Best-effort home dir (empty string on failure = list the provider root). */
async function safeHome(provider: FileSystemProvider): Promise<string> {
  try { return await provider.homeDir(); } catch { return ""; }
}

function errorMessage(err: unknown, fallback = "Unexpected error"): string {
  if (err && typeof err === "object" && "message" in err) return String((err as { message: string }).message);
  return typeof err === "string" ? err : fallback;
}

/** Path segment of our drag-out staging dir (temp_dir/anyscp-dragout/<uuid>). */
const DRAGOUT_STAGING_SEGMENT = "anyscp-dragout";

/** SFTP/SCP drag-out stages the whole selection to a temp dir before the OS drag
 *  can start; above this size the wait outlasts the drag gesture and looks like a
 *  hang, so we route to the download flow (with progress) instead. 5 MiB covers
 *  most everyday files while staying snappy enough that the inline drag doesn't
 *  read as frozen; the folder-picker fallback only kicks in for genuinely large
 *  items where a visible progress bar is the better trade. */
const DRAGOUT_STAGE_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

function isWindowsWebview(): boolean {
  return typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent);
}

interface DragDropEventPayload {
  payload: {
    type: "enter" | "over" | "drop" | "leave";
    paths: string[];
    position?: { x: number; y: number };
  };
}
