import { useEffect } from "react";
import { Loader2, AlertCircle, X } from "lucide-react";

interface ConnectionDialogProps {
  /** Host label or user@host shown during connecting */
  label: string;
  /** null = connecting, string = error message */
  error: string | null;
  onClose: () => void;
  onRetry?: () => void;
}

export function ConnectionDialog({ label, error, onClose, onRetry }: ConnectionDialogProps) {
  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg-base/60 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && error && onClose()}
    >
      <div className="w-full max-w-sm mx-4 rounded-xl bg-bg-overlay border border-border p-6 shadow-[var(--shadow-lg)] animate-[fadeIn_120ms_var(--ease-expo-out)_both]">
        {error ? (
          /* Error state */
          <>
            <div className="flex items-start gap-3 mb-4">
              <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-status-error/10 shrink-0">
                <AlertCircle size={20} strokeWidth={1.8} className="text-status-error" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-[length:var(--text-sm)] font-semibold text-text-primary">
                  Connection Failed
                </h2>
                <p className="text-[length:var(--text-xs)] text-text-muted mt-0.5">
                  {label}
                </p>
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-subtle transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0"
              >
                <X size={14} strokeWidth={2} />
              </button>
            </div>

            <div className="rounded-lg bg-status-error/5 border border-status-error/20 px-3 py-2.5 mb-5">
              <p className="text-[length:var(--text-xs)] text-status-error leading-relaxed">
                {error}
              </p>
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={onClose}
                className="px-4 py-2 text-[length:var(--text-sm)] text-text-secondary hover:text-text-primary rounded-lg transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Close
              </button>
              {onRetry && (
                <button
                  onClick={onRetry}
                  className="px-4 py-2 text-[length:var(--text-sm)] font-medium text-text-inverse bg-accent hover:bg-accent-hover rounded-lg transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Retry
                </button>
              )}
            </div>
          </>
        ) : (
          /* Connecting state */
          <div className="flex flex-col items-center gap-4 py-4">
            <Loader2 size={24} strokeWidth={2} className="text-accent motion-safe:animate-spin" />
            <div className="text-center">
              <p className="text-[length:var(--text-sm)] font-medium text-text-primary">
                Connecting...
              </p>
              <p className="text-[length:var(--text-xs)] text-text-muted mt-1">
                {label}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
