import { AlertTriangle } from "lucide-react";
import { ModalShell, BTN_GHOST, BTN_DANGER } from "./ModalShell";

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
  return (
    <ModalShell
      open={open}
      onClose={onCancel}
      title={title}
      icon={AlertTriangle}
      iconVariant="danger"
      maxWidth="sm"
      busy={busy}
      footer={
        <>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <button autoFocus type="button" onClick={onCancel} disabled={busy} className={BTN_GHOST}>
            {cancelLabel}
          </button>
          <button type="button" onClick={onConfirm} disabled={busy} className={BTN_DANGER}>
            {busy ? "Deleting…" : confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-[length:var(--text-sm)] text-text-secondary">{message}</p>
    </ModalShell>
  );
}
