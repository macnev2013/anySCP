import { useState, useId } from "react";
import { AlertTriangle } from "lucide-react";
import type { HostGroup } from "../../types";
import { ModalShell, BTN_GHOST, BTN_DANGER } from "../shared/ModalShell";

interface GroupDeleteDialogProps {
  group: HostGroup;
  hostCount: number;
  onConfirm: (deleteHosts: boolean) => void;
  onCancel: () => void;
}

export function GroupDeleteDialog({
  group,
  hostCount,
  onConfirm,
  onCancel,
}: GroupDeleteDialogProps) {
  const [deleteHosts, setDeleteHosts] = useState(false);
  const checkboxId = useId();

  const confirmLabel =
    hostCount > 0 && deleteHosts ? "Delete Group & Hosts" : "Delete Group";

  return (
    <ModalShell
      open
      onClose={onCancel}
      title={`Delete "${group.name}"?`}
      icon={AlertTriangle}
      iconVariant="danger"
      maxWidth="sm"
      footer={
        <>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <button autoFocus type="button" onClick={onCancel} className={BTN_GHOST}>
            Cancel
          </button>
          <button type="button" onClick={() => onConfirm(deleteHosts)} className={BTN_DANGER}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[length:var(--text-sm)] text-text-secondary">
          {hostCount === 0
            ? "This empty group will be permanently removed."
            : `This group contains ${hostCount} ${hostCount === 1 ? "host" : "hosts"}.`}
        </p>

        {hostCount > 0 && (
          <label
            htmlFor={checkboxId}
            className="flex items-start gap-2.5 cursor-pointer rounded-lg px-3 py-2.5 bg-bg-subtle border border-border hover:border-border-focus transition-colors duration-[var(--duration-fast)]"
          >
            <input
              id={checkboxId}
              type="checkbox"
              checked={deleteHosts}
              onChange={(e) => setDeleteHosts(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 rounded shrink-0 cursor-pointer accent-[oklch(0.650_0.200_25)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <span className="text-[length:var(--text-xs)] text-text-secondary leading-snug select-none">
              Also delete all {hostCount} {hostCount === 1 ? "host" : "hosts"} in this group
              <span className="block text-text-muted mt-0.5">
                Unchecked: hosts will be moved out of the group
              </span>
            </span>
          </label>
        )}
      </div>
    </ModalShell>
  );
}
