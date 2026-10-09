import { useCallback, useEffect, useMemo } from "react";
import { Folder, RefreshCw } from "lucide-react";
import { useS3Store } from "../../stores/s3-store";
import type { S3BucketInfo } from "../../types";
import { createS3Provider } from "../../providers/s3-provider";
import { Explorer } from "../explorer/Explorer";
import type { PaneRuntime, CrossPaneTarget } from "../../types/explorer";

interface S3ExplorerProps {
  sessionId: string;
  isActive?: boolean;
  /** Dual-pane coordinator props, threaded to the underlying Explorer so an S3
   *  pane can take part in cross-pane transfer (upload/download) the same way an
   *  SFTP pane does. Absent in single-pane. */
  tabActive?: boolean;
  registerRuntime?: (runtime: PaneRuntime | null) => void;
  crossPane?: CrossPaneTarget;
  dense?: boolean;
}

/**
 * S3 bucket gate. Bucket selection is connection-level (not file browsing), so
 * it lives here; once a bucket is active this delegates to the shared `Explorer`
 * with an S3 provider. Keeps the unified container backend-agnostic.
 */
export function S3Explorer({ sessionId, isActive = true, tabActive, registerRuntime, crossPane, dense }: S3ExplorerProps) {
  const session = useS3Store((s) => s.sessions.get(sessionId));
  const setBuckets = useS3Store((s) => s.setBuckets);
  const setCurrentBucket = useS3Store((s) => s.setCurrentBucket);
  const setLoading = useS3Store((s) => s.setLoading);
  const setError = useS3Store((s) => s.setError);

  const provider = useMemo(
    () => createS3Provider(sessionId, session?.currentBucket ?? ""),
    [sessionId, session?.currentBucket],
  );

  const loadBuckets = useCallback(async () => {
    setLoading(sessionId, true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      setBuckets(sessionId, await invoke<S3BucketInfo[]>("s3_list_buckets", { s3SessionId: sessionId }));
    } catch (err) {
      setError(sessionId, errMsg(err, "Failed to list buckets"));
    }
  }, [sessionId, setLoading, setBuckets, setError]);

  const selectBucket = useCallback(async (bucketName: string) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("s3_switch_bucket", { s3SessionId: sessionId, bucketName });
      // Switch to the object browser; Explorer's mount loads the bucket root.
      setCurrentBucket(sessionId, bucketName);
    } catch (err) {
      setError(sessionId, errMsg(err, "Failed to switch bucket"));
    }
  }, [sessionId, setCurrentBucket, setError]);

  useEffect(() => {
    if (!session?.currentBucket) void loadBuckets();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, session?.currentBucket]);

  if (!session) return null;

  if (session.currentBucket) {
    // Remount on bucket change so the listing reloads.
    return (
      <Explorer
        key={session.currentBucket}
        provider={provider}
        isActive={isActive}
        tabActive={tabActive}
        registerRuntime={registerRuntime}
        crossPane={crossPane}
        dense={dense}
      />
    );
  }

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
          <p className="text-[length:var(--text-sm)] text-text-muted px-4 py-8 text-center">No buckets found</p>
        )}
      </div>
    </div>
  );
}

function errMsg(err: unknown, fallback: string): string {
  return err && typeof err === "object" && "message" in err
    ? String((err as { message: string }).message)
    : fallback;
}
