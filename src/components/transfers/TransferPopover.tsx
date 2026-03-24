import { useEffect, useRef, useMemo, useCallback } from "react";
import { X } from "lucide-react";
import { useTransferStore } from "../../stores/transfer-store";
import type { TransferEvent, TransferStatusValue } from "../../types";
import { getStatusString } from "../../utils/format";
import { TransferRow } from "./TransferRow";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sortPriority(status: TransferStatusValue): number {
  const s = getStatusString(status);
  if (s === "InProgress") return 0;
  if (s === "Queued") return 1;
  return 2;
}

interface Stats {
  list: TransferEvent[];
  activeCount: number;
  queuedCount: number;
  finishedCount: number;
}

function computeStats(transfers: Map<string, TransferEvent>): Stats {
  let activeCount = 0;
  let queuedCount = 0;
  let finishedCount = 0;
  const list: TransferEvent[] = [];

  for (const t of transfers.values()) {
    list.push(t);
    const s = getStatusString(t.status);
    if (s === "InProgress") activeCount++;
    if (s === "Queued") queuedCount++;
    if (s === "Completed" || s === "Failed" || s === "Cancelled") finishedCount++;
  }

  list.sort((a, b) => sortPriority(a.status) - sortPriority(b.status));
  return { list, activeCount, queuedCount, finishedCount };
}

// ─── Component ───────────────────────────────────────────────────────────────

interface TransferPopoverProps {
  /** Rect of the trigger button — used to anchor the popover */
  anchorRect: DOMRect | null;
  onClose: () => void;
}

export function TransferPopover({ anchorRect, onClose }: TransferPopoverProps) {
  const transfers = useTransferStore((s) => s.transfers);
  const removeTransfer = useTransferStore((s) => s.removeTransfer);
  const clearFinished = useTransferStore((s) => s.clearFinished);
  const popoverRef = useRef<HTMLDivElement>(null);

  const stats = useMemo(() => computeStats(transfers), [transfers]);
  const { list, activeCount, queuedCount, finishedCount } = stats;

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay attachment to avoid the triggering click from immediately closing
    const timer = setTimeout(() => document.addEventListener("mousedown", handleClick), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // ─── Actions ────────────────────────────────────────────────────────────────

  /** Determine if a transfer is S3-based (vs SFTP) */
  const isS3Transfer = useCallback((id: string): boolean => {
    const t = transfers.get(id);
    return t ? !!t.s3_session_id : false;
  }, [transfers]);

  const handleCancel = useCallback((id: string) => {
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const cmd = isS3Transfer(id) ? "s3_cancel_transfer" : "sftp_cancel_transfer";
        await invoke(cmd, { transferId: id });
      } catch {
        removeTransfer(id);
      }
    })();
  }, [removeTransfer, isS3Transfer]);

  const handleRetry = useCallback((id: string) => {
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const cmd = isS3Transfer(id) ? "s3_retry_transfer" : "sftp_retry_transfer";
        await invoke(cmd, { transferId: id });
      } catch { /* best-effort */ }
    })();
  }, [isS3Transfer]);

  const handleDismiss = useCallback((id: string) => {
    removeTransfer(id);
  }, [removeTransfer]);

  const handleClearFinished = useCallback(() => {
    clearFinished();
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("sftp_clear_finished_transfers");
        await invoke("s3_clear_finished_transfers");
      } catch { /* best-effort */ }
    })();
  }, [clearFinished]);

  // ─── Positioning ────────────────────────────────────────────────────────────

  // Anchor to the right of the trigger, aligned to bottom
  const style: React.CSSProperties = {};
  if (anchorRect) {
    style.position = "fixed";
    style.left = anchorRect.right + 8;
    style.bottom = window.innerHeight - anchorRect.bottom;
    style.zIndex = 50;
  }

  // ─── Summary text ───────────────────────────────────────────────────────────

  const summaryParts: string[] = [];
  if (activeCount > 0) summaryParts.push(`${activeCount} active`);
  if (queuedCount > 0) summaryParts.push(`${queuedCount} queued`);
  if (finishedCount > 0) summaryParts.push(`${finishedCount} done`);

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Transfers"
      style={style}
      className={[
        "w-[340px] flex flex-col",
        "bg-bg-surface border border-border rounded-xl",
        "shadow-[var(--shadow-lg)]",
        "animate-[fadeIn_120ms_var(--ease-expo-out)_both]",
      ].join(" ")}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-border/60 shrink-0">
        <span className="text-[length:var(--text-xs)] font-semibold text-text-primary">
          Transfers
        </span>

        {summaryParts.length > 0 && (
          <span className="text-[length:var(--text-2xs)] text-text-muted tabular-nums">
            {summaryParts.join(" \u00b7 ")}
          </span>
        )}

        <span className="flex-1" />

        {/* Clear finished */}
        {finishedCount > 0 && (
          <button
            onClick={handleClearFinished}
            title="Clear completed transfers"
            aria-label="Clear completed transfers"
            className={[
              "flex items-center gap-1 px-2 py-1 rounded-md",
              "text-[length:var(--text-2xs)] font-medium",
              "text-text-muted hover:text-text-secondary hover:bg-bg-subtle",
              "transition-colors duration-[var(--duration-fast)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            ].join(" ")}
          >
            Clear
          </button>
        )}

        {/* Close */}
        <button
          onClick={onClose}
          title="Close"
          aria-label="Close transfers"
          className={[
            "flex items-center justify-center w-7 h-7 rounded-md",
            "text-text-muted hover:text-text-primary hover:bg-bg-subtle",
            "transition-colors duration-[var(--duration-fast)]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          ].join(" ")}
        >
          <X size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      {/* Transfer list */}
      {list.length > 0 ? (
        <div
          className="overflow-y-auto flex-1"
          style={{ maxHeight: "min(400px, 50vh)" }}
          role="list"
          aria-label="Transfer items"
        >
          {list.map((t) => (
            <TransferRow
              key={t.transfer_id}
              transfer={t}
              onCancel={handleCancel}
              onRetry={handleRetry}
              onDismiss={handleDismiss}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-10 gap-2">
          <p className="text-[length:var(--text-xs)] text-text-muted">
            No transfers
          </p>
          <p className="text-[length:var(--text-2xs)] text-text-muted/60">
            Drag files onto the explorer to upload
          </p>
        </div>
      )}
    </div>
  );
}
