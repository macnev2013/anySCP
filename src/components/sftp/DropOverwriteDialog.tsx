import { useEffect, useRef } from "react";
import { AlertTriangle, X } from "lucide-react";

interface DropOverwriteDialogProps {
  conflicts: string[];
  targetDir: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation shown when a drag-drop upload would overwrite existing remote
 * entries. The conflict list is computed from top-level basenames, so for a
 * dropped folder the match means the folder already exists — its contents are
 * merged and only same-named files inside are replaced (see the note below).
 */
export function DropOverwriteDialog({
  conflicts,
  targetDir,
  onConfirm,
  onCancel,
}: DropOverwriteDialogProps) {
  const count = conflicts.length;
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [onCancel]);

  return (
    <div
      data-testid="explorer-overwrite-confirm"
      className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh] bg-black/50 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div
        aria-modal="true"
        role="dialog"
        aria-labelledby="explorer-overwrite-title"
        className="w-full max-w-sm rounded-xl bg-bg-overlay border border-border shadow-[var(--shadow-lg)] flex flex-col animate-in fade-in slide-in-from-top-2 duration-[var(--duration-base)]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-7 h-7 rounded-md shrink-0 bg-status-error/10">
              <AlertTriangle size={15} strokeWidth={1.8} className="text-status-error" aria-hidden="true" />
            </div>
            <h2 id="explorer-overwrite-title" className="text-[length:var(--text-lg)] font-semibold text-text-primary">
              {count === 1 ? "Overwrite item?" : `Overwrite ${count} items?`}
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-subtle transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 flex flex-col gap-3">
          <p className="text-[length:var(--text-sm)] text-text-secondary">
            {count === 1 ? (
              <><span className="font-mono text-text-primary">{conflicts[0]}</span> already exists here.</>
            ) : (
              <>{count} items already exist here.</>
            )}
          </p>
          {count > 1 && (
            <ul className="max-h-32 overflow-y-auto rounded-md bg-bg-base border border-border/60 p-2 flex flex-col gap-0.5">
              {conflicts.map((n) => (
                <li key={n} className="font-mono text-[length:var(--text-2xs)] text-text-secondary truncate">
                  {n}
                </li>
              ))}
            </ul>
          )}
          <p className="text-[length:var(--text-2xs)] text-text-muted">
            Files are replaced; folders are merged, replacing only same-named files inside.
          </p>
          <p className="font-mono text-[length:var(--text-2xs)] text-text-muted truncate">{targetDir}</p>
        </div>

        {/* Footer */}
        <div className="px-6 pb-5 pt-3 flex items-center justify-end gap-2 border-t border-border shrink-0">
          <button
            ref={cancelRef}
            data-testid="explorer-overwrite-cancel"
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-[length:var(--text-sm)] font-medium text-text-secondary hover:text-text-primary rounded-lg transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Cancel
          </button>
          <button
            data-testid="explorer-overwrite-confirm-button"
            type="button"
            onClick={onConfirm}
            className="px-4 py-2 text-[length:var(--text-sm)] font-medium text-text-inverse bg-accent hover:bg-accent-hover rounded-lg transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {count === 1 ? "Overwrite" : `Overwrite ${count}`}
          </button>
        </div>
      </div>
    </div>
  );
}
