import { AlertTriangle } from "lucide-react";
import { ModalShell, BTN_GHOST, BTN_PRIMARY } from "../shared/ModalShell";

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
 * merged and only same-named files inside are replaced.
 */
export function DropOverwriteDialog({
  conflicts,
  targetDir,
  onConfirm,
  onCancel,
}: DropOverwriteDialogProps) {
  const count = conflicts.length;

  return (
    <ModalShell
      open
      onClose={onCancel}
      title={count === 1 ? "Overwrite item?" : `Overwrite ${count} items?`}
      icon={AlertTriangle}
      iconVariant="danger"
      maxWidth="sm"
      testId="explorer-overwrite-confirm"
      footer={
        <>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <button autoFocus data-testid="explorer-overwrite-cancel" type="button" onClick={onCancel} className={BTN_GHOST}>
            Cancel
          </button>
          <button data-testid="explorer-overwrite-confirm-button" type="button" onClick={onConfirm} className={BTN_PRIMARY}>
            {count === 1 ? "Overwrite" : `Overwrite ${count}`}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
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
              <li key={n} className="font-mono text-[length:var(--text-2xs)] text-text-secondary truncate">{n}</li>
            ))}
          </ul>
        )}
        <p className="text-[length:var(--text-2xs)] text-text-muted">
          Files are replaced; folders are merged, replacing only same-named files inside.
        </p>
        <p className="font-mono text-[length:var(--text-2xs)] text-text-muted truncate">{targetDir}</p>
      </div>
    </ModalShell>
  );
}
