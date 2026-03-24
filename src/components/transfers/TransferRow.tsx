import { memo } from "react";
import { ArrowDown, ArrowUp, X, RotateCw } from "lucide-react";
import type { TransferEvent, TransferStatusValue } from "../../types";
import { useTransferStore } from "../../stores/transfer-store";
import { formatBytes, formatSpeed, formatEta, getStatusString } from "../../utils/format";

// ─── Helpers (pure, no allocation) ───────────────────────────────────────────

function getProgressPercent(t: TransferEvent): number {
  if (t.total_bytes === 0) return 0;
  return Math.min(100, Math.round((t.bytes_transferred / t.total_bytes) * 100));
}

function isTerminal(status: TransferStatusValue): boolean {
  const s = getStatusString(status);
  return s === "Completed" || s === "Cancelled" || s === "Failed";
}

function isFailed(status: TransferStatusValue): boolean {
  return typeof status === "object" && "Failed" in status;
}

function getErrorMessage(status: TransferStatusValue): string {
  if (typeof status === "object" && "Failed" in status) return status.Failed;
  return "";
}

// ─── Static class strings (hoisted to avoid re-join per render) ──────────────

const ACTION_BTN_CLASS = [
  "flex items-center justify-center",
  "w-7 h-7 rounded-md shrink-0",
  "transition-colors duration-[var(--duration-fast)]",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
].join(" ");

const ROW_CLASS = [
  "group flex flex-col gap-1.5 px-3 py-2.5",
  "border-b border-border/40 last:border-b-0",
  "transition-colors duration-[var(--duration-fast)]",
  "hover:bg-bg-overlay/50",
].join(" ");

const ACTIONS_CONTAINER_CLASS = [
  "flex items-center gap-0.5 shrink-0",
  "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
  "transition-opacity duration-[var(--duration-fast)]",
].join(" ");

// ─── Progress Bar ────────────────────────────────────────────────────────────

const SHIMMER_STYLE: React.CSSProperties = {
  background:
    "linear-gradient(90deg, transparent 0%, var(--color-text-primary) 50%, transparent 100%)",
  animation: "shimmer 1.8s var(--ease-expo-out) infinite",
};

const ProgressBar = memo(function ProgressBar({ pct, status, label }: {
  pct: number;
  status: TransferStatusValue;
  label: string;
}) {
  const s = getStatusString(status);
  const isActive = s === "InProgress";

  const barColor =
    s === "Completed"  ? "var(--color-status-connected)" :
    s === "Failed"     ? "var(--color-status-error)" :
    s === "Cancelled"  ? "var(--color-text-muted)" :
                         "var(--color-accent)";

  return (
    <div
      className="w-full h-[3px] rounded-full bg-bg-subtle overflow-hidden"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div
        className={[
          "h-full rounded-full",
          "transition-[width] duration-[var(--duration-base)]",
          isActive ? "relative overflow-hidden" : "",
        ].join(" ")}
        style={{ width: `${pct}%`, backgroundColor: barColor }}
      >
        {isActive && (
          <span className="absolute inset-0 opacity-20" style={SHIMMER_STYLE} />
        )}
      </div>
    </div>
  );
});

// ─── Component ───────────────────────────────────────────────────────────────

interface TransferRowProps {
  transfer: TransferEvent;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
}

export const TransferRow = memo(function TransferRow({
  transfer: t,
  onCancel,
  onRetry,
  onDismiss,
}: TransferRowProps) {
  const sessionId = t.sftp_session_id ?? t.s3_session_id ?? "";
  const hostLabel = useTransferStore((s) => s.hostLabels.get(sessionId));

  const pct = getProgressPercent(t);
  const terminal = isTerminal(t.status);
  const failed = isFailed(t.status);
  const statusStr = getStatusString(t.status);
  const isQueued = statusStr === "Queued";
  const isInProgress = statusStr === "InProgress";
  const isCompleted = statusStr === "Completed";
  const isCancelled = statusStr === "Cancelled";

  const hasMultipleFiles = t.files_total > 1;
  const errorMsg = getErrorMessage(t.status);

  const statusLabel =
    isInProgress ? `${pct}%` :
    isQueued     ? "Queued" :
    isCompleted  ? "Done" :
    isCancelled  ? "Cancelled" :
    failed       ? "Failed" : "";

  const statusColor =
    isCompleted  ? "text-status-connected" :
    failed       ? "text-status-error" :
    isInProgress ? "text-accent" :
                   "text-text-muted";

  const progressLabel = `${t.name} ${t.direction.toLowerCase()} progress`;

  return (
    <div className={ROW_CLASS} role="listitem">
      {/* Row 1: direction icon + name + status + actions */}
      <div className="flex items-center gap-2.5 min-w-0">
        {/* Direction icon */}
        <span
          className={[
            "shrink-0 flex items-center justify-center w-5 h-5 rounded",
            t.direction === "Upload"
              ? "text-accent bg-accent/8"
              : "text-status-connected bg-status-connected/8",
          ].join(" ")}
          aria-hidden="true"
        >
          {t.direction === "Upload" ? (
            <ArrowUp size={12} strokeWidth={2.5} />
          ) : (
            <ArrowDown size={12} strokeWidth={2.5} />
          )}
        </span>

        {/* Name + host + file count */}
        <div className="flex-1 min-w-0">
          <p className="text-[length:var(--text-xs)] text-text-primary truncate leading-tight font-medium">
            {t.name}
          </p>
          <p className="text-[length:var(--text-2xs)] text-text-muted leading-tight mt-px truncate">
            {hostLabel && <span>{hostLabel}</span>}
            {hostLabel && hasMultipleFiles && <span> · </span>}
            {hasMultipleFiles && (
              <span className="tabular-nums">{t.files_done}/{t.files_total} files</span>
            )}
          </p>
        </div>

        {/* Status label — hidden for completed (tick shown in actions area instead) */}
        {!isCompleted && (
          <span className={`text-[length:var(--text-2xs)] font-medium tabular-nums shrink-0 ${statusColor}`}>
            {statusLabel}
          </span>
        )}

        {/* Actions — visible on hover, always accessible via keyboard */}
        <div className={ACTIONS_CONTAINER_CLASS}>
          {failed && (
            <button
              onClick={() => onRetry(t.transfer_id)}
              title="Retry transfer"
              aria-label={`Retry ${t.name}`}
              className={`${ACTION_BTN_CLASS} text-text-muted hover:text-accent hover:bg-accent/10`}
            >
              <RotateCw size={13} strokeWidth={2} aria-hidden="true" />
            </button>
          )}

          {(isInProgress || isQueued) && (
            <button
              onClick={() => onCancel(t.transfer_id)}
              title="Cancel transfer"
              aria-label={`Cancel ${t.name}`}
              className={`${ACTION_BTN_CLASS} text-text-muted hover:text-status-error hover:bg-status-error/10`}
            >
              <X size={13} strokeWidth={2} aria-hidden="true" />
            </button>
          )}

          {terminal && (
            <button
              onClick={() => onDismiss(t.transfer_id)}
              title="Dismiss"
              aria-label={`Dismiss ${t.name}`}
              className={`${ACTION_BTN_CLASS} text-text-muted hover:text-text-primary hover:bg-bg-subtle`}
            >
              <X size={13} strokeWidth={2} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* Row 2: Progress bar */}
      <ProgressBar pct={pct} status={t.status} label={progressLabel} />

      {/* Row 3: Detail line */}
      <div className="flex items-center justify-between gap-3 min-h-[14px]">
        {failed ? (
          <p
            className="text-[length:var(--text-2xs)] text-status-error truncate"
            title={errorMsg}
          >
            {errorMsg}
          </p>
        ) : isInProgress ? (
          <>
            <span className="text-[length:var(--text-2xs)] text-text-muted tabular-nums">
              {formatBytes(t.bytes_transferred)} / {formatBytes(t.total_bytes)}
            </span>
            <span className="flex items-center gap-2 text-[length:var(--text-2xs)] text-text-muted tabular-nums shrink-0">
              {t.speed_bps > 0 && <span>{formatSpeed(t.speed_bps)}</span>}
              {t.eta_secs !== null && t.eta_secs > 0 && (
                <span className="text-text-muted/70">{formatEta(t.eta_secs)}</span>
              )}
            </span>
          </>
        ) : isCompleted ? (
          <span className="text-[length:var(--text-2xs)] text-text-muted tabular-nums">
            {formatBytes(t.total_bytes)}
          </span>
        ) : isQueued ? (
          <span className="text-[length:var(--text-2xs)] text-text-muted">
            {t.total_bytes > 0 ? formatBytes(t.total_bytes) : (
              <span style={{ animation: "pulseSubtle 2s ease-in-out infinite" }}>
                Calculating...
              </span>
            )}
          </span>
        ) : null}
      </div>
    </div>
  );
});
