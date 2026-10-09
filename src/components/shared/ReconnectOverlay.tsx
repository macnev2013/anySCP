import { WifiOff, AlertTriangle, RefreshCw, X } from "lucide-react";

interface ReconnectOverlayProps {
  /** Short identity shown in the pill, e.g. "user@host" or a connection label. */
  label: string;
  status: "Disconnected" | "Error";
  /** Backend status message (e.g. why the connection dropped). */
  message?: string;
  /** Error from the last reconnect attempt, if any. */
  error?: string | null;
  /** A reconnect is in flight. */
  busy: boolean;
  onReconnect: () => void;
  onClose: () => void;
  /** Button label while busy (default "Connecting"). */
  busyLabel?: string;
}

/**
 * Pane-agnostic "connection lost / error → reconnect" toast, anchored to the
 * bottom of whatever pane hosts it. The reconnect and close actions are injected
 * so terminals and explorers can each re-dial (and tear down) their own way,
 * while the presentation stays identical across pane kinds.
 */
export function ReconnectOverlay({
  label,
  status,
  message,
  error,
  busy,
  onReconnect,
  onClose,
  busyLabel = "Connecting",
}: ReconnectOverlayProps) {
  const isError = status === "Error";
  const detail = error || message;

  return (
    <div
      className="absolute inset-0 z-10 flex items-end justify-center pb-6 pointer-events-none"
      aria-modal="true"
      role="dialog"
      aria-label={isError ? "Connection error" : "Connection lost"}
    >
      {/* Pill-shaped toast anchored to the bottom of the pane */}
      <div className="pointer-events-auto flex items-center gap-3 pl-3 pr-1.5 py-1.5 rounded-full bg-bg-overlay/95 border border-border shadow-[var(--shadow-lg)] backdrop-blur-md motion-safe:animate-[toast-up_var(--duration-slow)_var(--ease-expo-out)_both]">
        {/* Status indicator */}
        <div className={`flex items-center justify-center w-5 h-5 rounded-full shrink-0 ${isError ? "bg-status-error/15" : "bg-bg-subtle"}`}>
          {isError
            ? <AlertTriangle size={11} strokeWidth={2.5} className="text-status-error" aria-hidden="true" />
            : <WifiOff size={11} strokeWidth={2.5} className="text-text-muted" aria-hidden="true" />
          }
        </div>

        {/* Label */}
        <span className="text-[length:var(--text-xs)] text-text-muted font-mono truncate max-w-[160px]">
          {label}
        </span>

        {/* Error / status detail */}
        {detail && (
          <span className="text-[11px] text-status-error truncate max-w-[120px]" title={detail}>
            {detail}
          </span>
        )}

        {/* Divider */}
        <div className="w-px h-4 bg-border shrink-0" aria-hidden="true" />

        {/* Reconnect */}
        <button
          type="button"
          onClick={onReconnect}
          disabled={busy}
          className="inline-flex items-center gap-1 h-6 px-2.5 rounded-full text-[11px] font-medium text-text-inverse bg-accent hover:bg-accent-hover disabled:opacity-50 transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0"
          aria-label="Reconnect"
        >
          <RefreshCw
            size={11}
            strokeWidth={2.5}
            aria-hidden="true"
            className={busy ? "motion-safe:animate-spin" : ""}
          />
          {busy ? busyLabel : "Reconnect"}
        </button>

        {/* Close */}
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="inline-flex items-center justify-center w-6 h-6 rounded-full text-text-muted hover:text-text-primary hover:bg-bg-subtle disabled:opacity-50 transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0"
          aria-label="Close session"
        >
          <X size={12} strokeWidth={2.2} aria-hidden="true" />
        </button>
      </div>

      <style>{`
        @keyframes toast-up {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
