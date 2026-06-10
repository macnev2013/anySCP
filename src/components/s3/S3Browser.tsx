import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Folder, RefreshCw, AlertCircle } from "lucide-react";
import { useS3Store } from "../../stores/s3-store";
import type { S3BucketInfo, S3ListResult } from "../../types";
import type { ExplorerEntry } from "../../types/explorer";
import { ExplorerToolbar, ExplorerFileTable, ExplorerDropZone } from "../explorer";
import { createS3Provider, toS3ExplorerEntry } from "../../providers/s3-provider";
import { editorLaunchErrorMessage } from "../../lib/editor-errors";
import { toast } from "../../stores/toast-store";
import type { EditorConfig } from "../../stores/settings-store";

interface S3BrowserProps {
  sessionId: string;
  /** Whether this explorer's tab is currently active/visible. S3 tabs stay
   *  mounted (issue #17), so document-level listeners are gated to the active
   *  instance to avoid every open explorer reacting to one event. */
  isActive?: boolean;
}

export function S3Browser({ sessionId, isActive = true }: S3BrowserProps) {
  const session = useS3Store((s) => s.sessions.get(sessionId));
  const setEntries = useS3Store((s) => s.setEntries);
  const setBuckets = useS3Store((s) => s.setBuckets);
  const setCurrentBucket = useS3Store((s) => s.setCurrentBucket);
  const setLoading = useS3Store((s) => s.setLoading);
  const setError = useS3Store((s) => s.setError);
  const setSort = useS3Store((s) => s.setSort);
  const clipboard = useS3Store((s) => s.clipboard);
  const setClipboard = useS3Store((s) => s.setClipboard);

  const provider = useMemo(
    () => createS3Provider(sessionId, session?.currentBucket ?? ""),
    [sessionId, session?.currentBucket],
  );

  // ─── Drag-and-drop (OS → App) ─────────────────────────────────────────────

  const [isDragOver, setIsDragOver] = useState(false);
  const isProcessingDrop = useRef(false);
  const currentPrefixRef = useRef(session?.currentPrefix ?? "");
  currentPrefixRef.current = session?.currentPrefix ?? "";

  useEffect(() => {
    if (!session?.currentBucket) return;
    // Browser tabs stay mounted (issue #17), so without this guard every open
    // S3 browser's window-level listener would fire on a single drop and upload
    // into every session at once. Only the visible tab listens.
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
          const type = event.payload?.type;
          if (type === "enter" || type === "over") {
            setIsDragOver(true);
          } else if (type === "drop") {
            setIsDragOver(false);

            const paths: string[] = event.payload?.paths ?? [];
            if (isProcessingDrop.current || paths.length === 0) return;
            isProcessingDrop.current = true;

            const prefix = currentPrefixRef.current;

            void (async () => {
              try {
                const { invoke } = await import("@tauri-apps/api/core");
                await invoke("s3_enqueue_upload", {
                  s3SessionId: sessionId,
                  localPaths: paths,
                  prefix,
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
        // Tauri API not available
      }
    })();

    return () => { aborted = true; unlisten?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, session?.currentBucket, isActive]);

  // ─── Load buckets / objects ───────────────────────────────────────────────

  const loadBuckets = useCallback(async () => {
    setLoading(sessionId, true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const buckets = await invoke<S3BucketInfo[]>("s3_list_buckets", { s3SessionId: sessionId });
      setBuckets(sessionId, buckets);
    } catch (err) {
      const msg = err && typeof err === "object" && "message" in err
        ? String((err as { message: string }).message) : "Failed to list buckets";
      setError(sessionId, msg);
    }
  }, [sessionId, setLoading, setBuckets, setError]);

  const loadObjects = useCallback(async (prefix: string) => {
    setLoading(sessionId, true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<S3ListResult>("s3_list_objects", {
        s3SessionId: sessionId,
        prefix,
        continuationToken: null,
      });
      setEntries(sessionId, prefix, result.entries);
    } catch (err) {
      const msg = err && typeof err === "object" && "message" in err
        ? String((err as { message: string }).message) : "Failed to list objects";
      setError(sessionId, msg);
    }
  }, [sessionId, setLoading, setEntries, setError]);

  const selectBucket = useCallback(async (bucketName: string) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("s3_switch_bucket", { s3SessionId: sessionId, bucketName });
      setCurrentBucket(sessionId, bucketName);
      await loadObjects("");
    } catch (err) {
      const msg = err && typeof err === "object" && "message" in err
        ? String((err as { message: string }).message) : "Failed to switch bucket";
      setError(sessionId, msg);
    }
  }, [sessionId, setCurrentBucket, loadObjects, setError]);

  useEffect(() => {
    // If a bucket was already selected (e.g. set by the card-click flow that
    // restores a saved connection's default bucket), load its objects.
    // Otherwise show the bucket picker.
    if (session?.currentBucket) void loadObjects("");
    else void loadBuckets();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, session?.currentBucket]);

  // ─── Auto-refresh on upload completion ────────────────────────────────────

  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (aborted) return;

        const unsub = await listen<{
          s3_session_id: string;
          direction: string;
          status: string;
        }>("s3:transfer", (event) => {
          const { s3_session_id, direction, status } = event.payload;
          if (
            s3_session_id === sessionId &&
            direction === "Upload" &&
            status === "Completed"
          ) {
            setTimeout(() => {
              const prefix = currentPrefixRef.current;
              void loadObjects(prefix);
            }, 300);
          }
        });

        if (aborted) { unsub(); } else { unlisten = unsub; }
      } catch { /* Not in Tauri context */ }
    })();
    return () => { aborted = true; unlisten?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // ─── New folder/file (inline) ─────────────────────────────────────────────

  const [creatingFolder, setCreatingFolder] = useState(false);
  const [creatingFile, setCreatingFile] = useState(false);

  useEffect(() => {
    // Only the active (visible) explorer reacts to document-level new-folder/
    // new-file events — S3 tabs now stay mounted (issue #17).
    if (!isActive) return;
    const folderHandler = () => setCreatingFolder(true);
    const fileHandler = () => setCreatingFile(true);
    document.addEventListener("explorer:new-folder", folderHandler);
    document.addEventListener("explorer:new-file", fileHandler);
    return () => {
      document.removeEventListener("explorer:new-folder", folderHandler);
      document.removeEventListener("explorer:new-file", fileHandler);
    };
  }, [isActive]);

  const handleCreateFile = useCallback(async (name: string) => {
    setCreatingFile(false);
    if (!name.trim() || !session) return;
    const key = session.currentPrefix + name.trim();
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("s3_create_file", { s3SessionId: sessionId, key });
      await loadObjects(session.currentPrefix);
    } catch { /* Error shown via refresh */ }
  }, [sessionId, session, loadObjects]);

  const handleCreateFolder = useCallback(async (name: string) => {
    setCreatingFolder(false);
    if (!name.trim() || !session) return;
    const prefix = session.currentPrefix + name.trim() + "/";
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("s3_create_folder", { s3SessionId: sessionId, prefix });
      await loadObjects(session.currentPrefix);
    } catch { /* Error shown via refresh */ }
  }, [sessionId, session, loadObjects]);

  // ─── Delete ──────────────────────────────────────────────────────────────

  const handleDelete = useCallback(async (entriesToDelete: ExplorerEntry[]) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      for (const entry of entriesToDelete) {
        if (entry.entryType === "Directory") {
          // Delete all objects under this prefix
          await invoke("s3_delete_prefix", { s3SessionId: sessionId, prefix: entry.id });
        } else {
          await invoke("s3_delete_object", { s3SessionId: sessionId, key: entry.id });
        }
      }
    } catch { /* Partial deletes may occur */ }
    if (session) void loadObjects(session.currentPrefix);
  }, [sessionId, session, loadObjects]);

  // ─── Download (enqueue) ────────────────────────────────────────────────────

  const handleDownload = useCallback(async (entry: ExplorerEntry) => {
    if (entry.entryType === "Directory") return;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const savePath = await save({ defaultPath: entry.name, title: `Download "${entry.name}"` });
      if (!savePath) return;

      // Download to the user-chosen (possibly renamed) path THROUGH the transfer
      // pipeline, so it streams to disk, shows progress, and is cancellable — and
      // any failure surfaces in the transfers panel instead of being dropped.
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("s3_enqueue_download_as", {
        s3SessionId: sessionId,
        key: entry.id,
        localPath: savePath,
      });
    } catch (err) {
      setError(sessionId, err instanceof Error ? err.message : String(err));
    }
  }, [sessionId, setError]);

  // ─── Upload (dialog, enqueue) ─────────────────────────────────────────────

  const handleUpload = useCallback(async () => {
    if (!session) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({ multiple: false, title: "Upload file" });
      if (!path || typeof path !== "string") return;

      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("s3_enqueue_upload", {
        s3SessionId: sessionId,
        localPaths: [path],
        prefix: session.currentPrefix,
      });
    } catch { /* best-effort */ }
  }, [sessionId, session]);

  // ─── Edit in external editor ───────────────────────────────────────────────

  const handleEditInEditor = useCallback((entry: ExplorerEntry, editor?: EditorConfig) => {
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("s3_edit_external", {
          s3SessionId: sessionId,
          key: entry.id,
          editor: editor ?? null,
        });
      } catch (err) {
        toast.error(editorLaunchErrorMessage(err));
      }
    })();
  }, [sessionId]);

  // ─── Presign URL ──────────────────────────────────────────────────────────

  const handlePresignUrl = useCallback(async (entry: ExplorerEntry) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const url = await invoke<string>("s3_presign_url", {
        s3SessionId: sessionId,
        key: entry.id,
        expirySecs: 3600,
      });
      await navigator.clipboard.writeText(url);
    } catch { /* best-effort */ }
  }, [sessionId]);

  // ─── Get Info ─────────────────────────────────────────────────────────────
  // For S3, `s3_head_object` returns fresh metadata. We don't need special
  // handling since the built-in FilePropertiesDialog in ExplorerFileTable works
  // with the existing ExplorerEntry data. If we wanted richer metadata, we could
  // fetch it here, but the current entry data is sufficient.

  // ─── Breadcrumb segments ──────────────────────────────────────────────────

  const prefix = session?.currentPrefix ?? "";
  const bucketName = session?.currentBucket ?? "";
  const prefixParts = prefix.split("/").filter(Boolean);
  const segments = [
    { label: bucketName, path: "" },
    ...prefixParts.map((seg, i) => ({
      label: seg,
      path: prefixParts.slice(0, i + 1).join("/") + "/",
    })),
  ];

  // ─── Explorer entries ─────────────────────────────────────────────────────

  const explorerEntries: ExplorerEntry[] = useMemo(
    () => (session?.entries ?? []).map(toS3ExplorerEntry),
    [session?.entries],
  );

  // ─── Guard ────────────────────────────────────────────────────────────────

  if (!session) return null;

  // ─── Bucket list view ──────────────────────────────────────────────────────

  if (!session.currentBucket) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex items-center h-10 px-3 border-b border-border bg-bg-surface shrink-0 gap-2 no-select">
          <span className="text-[length:var(--text-sm)] font-medium text-text-primary">Buckets</span>
          <span className="flex-1" />
          <button
            onClick={() => void loadBuckets()}
            title="Refresh"
            className="flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-text-secondary hover:bg-bg-subtle transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RefreshCw size={15} strokeWidth={1.8} className={session.loading ? "motion-safe:animate-spin" : ""} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {session.error && (
            <div className="px-4 py-3 bg-status-error/10 border-b border-status-error/20 text-status-error text-[length:var(--text-sm)]">
              {session.error}
            </div>
          )}
          {session.buckets.map((bucket) => (
            <button
              key={bucket.name}
              onClick={() => void selectBucket(bucket.name)}
              className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-bg-subtle transition-colors duration-[var(--duration-fast)] text-left"
            >
              <Folder size={16} strokeWidth={1.8} className="text-accent shrink-0" />
              <span className="text-[length:var(--text-sm)] text-text-primary font-mono">{bucket.name}</span>
            </button>
          ))}
          {!session.loading && session.buckets.length === 0 && !session.error && (
            <p className="text-[length:var(--text-sm)] text-text-muted px-4 py-8 text-center">
              No buckets found
            </p>
          )}
        </div>
      </div>
    );
  }

  // ─── Object browser view (using shared components) ────────────────────────

  return (
    <div className="flex flex-col h-full overflow-hidden relative">
      <ExplorerToolbar
        provider={provider}
        currentPath={session.currentPrefix}
        segments={segments}
        loading={session.loading}
        onNavigate={(path) => void loadObjects(path)}
        onRefresh={() => void loadObjects(session.currentPrefix)}
        onNewFile={() => setCreatingFile(true)}
        onNewFolder={() => setCreatingFolder(true)}
        onUpload={() => void handleUpload()}
      />

      {/* Error banner */}
      {session.error && (
        <div className="flex items-center gap-2.5 px-4 py-2.5 bg-status-error/10 border-b border-status-error/20 text-status-error">
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
        clipboard={clipboard}
        onSetClipboard={setClipboard}
        onNavigate={(path) => void loadObjects(path)}
        onDownload={(entry) => void handleDownload(entry)}
        onDelete={handleDelete}
        onEditInEditor={handleEditInEditor}
        onPresignUrl={(entry) => void handlePresignUrl(entry)}
        creatingFile={creatingFile}
        onCreateFile={(name) => void handleCreateFile(name)}
        onCancelCreateFile={() => setCreatingFile(false)}
        creatingFolder={creatingFolder}
        onCreateFolder={(name) => void handleCreateFolder(name)}
        onCancelCreateFolder={() => setCreatingFolder(false)}
        currentPath={session.currentPrefix}
        loading={session.loading}
      />

      {isDragOver && <ExplorerDropZone path={session.currentPrefix || bucketName} />}
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
