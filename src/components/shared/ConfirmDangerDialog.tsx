import { useEffect, useId, useRef } from "react";
import { AlertTriangle } from "lucide-react";

interface ConfirmDangerDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDangerDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDangerDialogProps) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus the Cancel button on open — safe default prevents accidental confirm.
  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  // Close on Escape (capture phase, consistent with GroupDeleteDialog).
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" aria-modal="true" role="dialog" aria-labelledby={titleId}>
      <div
        className="absolute inset-0 bg-bg-base/70 backdrop-blur-sm"
        onClick={() => { if (!busy) onCancel(); }}
        aria-hidden="true"
      />
      <div className="relative z-10 w-full max-w-sm mx-4 p-6 rounded-xl bg-bg-surface border border-border shadow-[var(--shadow-lg)]">
        <div className="flex items-start gap-3 mb-4">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg shrink-0 bg-status-error/10">
            <AlertTriangle size={18} strokeWidth={1.8} className="text-status-error" aria-hidden="true" />
          </div>
          <div>
            <h2 id={titleId} className="text-[length:var(--text-sm)] font-semibold text-text-primary">
              {title}
            </h2>
            <p className="text-[length:var(--text-xs)] text-text-muted mt-1">{message}</p>
          </div>
        </div>

        <div className="flex gap-2 justify-end">
          <button
            ref={cancelRef}
            onClick={onCancel}
            disabled={busy}
            className={[
              "px-4 py-1.5 rounded-lg text-[length:var(--text-sm)] font-medium",
              "text-text-secondary bg-bg-overlay border border-border",
              "hover:text-text-primary hover:border-border-focus hover:bg-bg-subtle",
              "transition-all duration-[var(--duration-fast)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "disabled:opacity-50 disabled:pointer-events-none",
            ].join(" ")}
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className={[
              "px-4 py-1.5 rounded-lg text-[length:var(--text-sm)] font-medium",
              "bg-status-error text-text-inverse",
              "hover:opacity-90 active:opacity-80",
              "transition-opacity duration-[var(--duration-fast)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "disabled:opacity-50 disabled:pointer-events-none",
            ].join(" ")}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
