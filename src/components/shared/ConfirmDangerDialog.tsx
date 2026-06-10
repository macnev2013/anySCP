import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, X } from "lucide-react";

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
  const [visible, setVisible] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  // Drive the entrance animation separately from open so the panel
  // fades/slides in after the backdrop is painted.
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => setVisible(true));
    } else {
      setVisible(false);
    }
  }, [open]);

  // Focus the Cancel button once the panel is visible.
  useEffect(() => {
    if (visible) requestAnimationFrame(() => cancelRef.current?.focus());
  }, [visible]);

  if (!open) return null;

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current && !busy) onCancel();
  };

  // Keyboard: Escape cancels; Enter inside the form submits (handled by onSubmit).
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && !busy) {
      e.stopPropagation();
      onCancel();
    }
  };

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className={[
        "fixed inset-0 z-50 flex items-start justify-center pt-[8vh]",
        "transition-[background-color,backdrop-filter] duration-[var(--duration-base)]",
        visible ? "bg-black/50 backdrop-blur-sm" : "bg-black/0 backdrop-blur-none",
      ].join(" ")}
    >
      <form
        onSubmit={(e) => { e.preventDefault(); if (!busy) onConfirm(); }}
        onKeyDown={handleKeyDown}
        aria-modal="true"
        role="dialog"
        aria-labelledby={titleId}
        className={[
          "w-full max-w-sm rounded-xl bg-bg-overlay border border-border shadow-[var(--shadow-lg)]",
          "flex flex-col",
          "transition-[opacity,transform] duration-[var(--duration-slow)] ease-[var(--ease-expo-out)]",
          visible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-3",
        ].join(" ")}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-7 h-7 rounded-md shrink-0 bg-status-error/10">
              <AlertTriangle size={15} strokeWidth={1.8} className="text-status-error" aria-hidden="true" />
            </div>
            <h2 id={titleId} className="text-[length:var(--text-base)] font-semibold text-text-primary">
              {title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            aria-label="Close"
            className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-subtle transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <X size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4">
          <p className="text-[length:var(--text-sm)] text-text-secondary">{message}</p>
        </div>

        {/* Footer */}
        <div className="px-6 pb-5 pt-3 flex items-center justify-end gap-2 border-t border-border shrink-0">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className={[
              "px-4 py-2 rounded-lg text-[length:var(--text-sm)] font-medium",
              "text-text-secondary hover:text-text-primary",
              "transition-colors duration-[var(--duration-fast)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "disabled:opacity-50 disabled:pointer-events-none",
            ].join(" ")}
          >
            {cancelLabel}
          </button>
          <button
            type="submit"
            disabled={busy}
            className={[
              "px-4 py-2 rounded-lg text-[length:var(--text-sm)] font-medium",
              "bg-status-error text-text-inverse",
              "hover:opacity-90 active:opacity-80",
              "transition-opacity duration-[var(--duration-fast)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "disabled:opacity-50 disabled:pointer-events-none",
            ].join(" ")}
          >
            {busy ? "Deleting…" : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
