import { useEffect, useRef } from "react";

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

  // Escape cancels; focus the (non-destructive) Cancel button on open so the
  // dialog is keyboard-operable and doesn't leave focus on the page behind it.
  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div
      data-testid="explorer-overwrite-confirm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="explorer-overwrite-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="w-full max-w-sm mx-4 rounded-xl bg-bg-overlay border border-border p-6 shadow-[var(--shadow-lg)]">
        <h2
          id="explorer-overwrite-title"
          className="text-[length:var(--text-lg)] font-semibold text-text-primary mb-2"
        >
          {count === 1 ? "Overwrite item?" : `Overwrite ${count} items?`}
        </h2>
        <p className="text-[length:var(--text-sm)] text-text-secondary mb-3">
          {count === 1 ? (
            <>
              <span className="font-mono text-text-primary">{conflicts[0]}</span> already exists
              here.
            </>
          ) : (
            <>{count} items already exist here.</>
          )}
        </p>
        {count > 1 && (
          <ul className="mb-3 max-h-32 overflow-y-auto rounded-md bg-bg-base border border-border/60 p-2 flex flex-col gap-0.5">
            {conflicts.map((n) => (
              <li key={n} className="font-mono text-[length:var(--text-2xs)] text-text-secondary truncate">
                {n}
              </li>
            ))}
          </ul>
        )}
        <p className="text-[length:var(--text-2xs)] text-text-muted mb-2">
          Files are replaced; folders are merged, replacing only same-named files inside.
        </p>
        <p className="font-mono text-[length:var(--text-2xs)] text-text-muted truncate mb-5">
          {targetDir}
        </p>

        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            data-testid="explorer-overwrite-cancel"
            onClick={onCancel}
            className="px-4 py-2 text-[length:var(--text-sm)] text-text-secondary hover:text-text-primary rounded-lg transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Cancel
          </button>
          <button
            data-testid="explorer-overwrite-confirm-button"
            onClick={onConfirm}
            className="px-4 py-2 text-[length:var(--text-sm)] font-medium text-white bg-accent hover:opacity-90 rounded-lg transition-[opacity] duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {count === 1 ? "Overwrite" : `Overwrite ${count}`}
          </button>
        </div>
      </div>
    </div>
  );
}
