import { useState, useEffect, useId } from "react";
import { AlertTriangle, X } from "lucide-react";
import type { HostGroup } from "../../types";

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
  const titleId = useId();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [onCancel]);

  const confirmLabel =
    hostCount > 0 && deleteHosts ? "Delete Group & Hosts" : "Delete Group";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh] bg-black/50 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div
        aria-modal="true"
        role="dialog"
        aria-labelledby={titleId}
        className="w-full max-w-sm rounded-xl bg-bg-overlay border border-border shadow-[var(--shadow-lg)] flex flex-col animate-in fade-in slide-in-from-top-2 duration-[var(--duration-base)]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-7 h-7 rounded-md shrink-0 bg-status-error/10">
              <AlertTriangle size={15} strokeWidth={1.8} className="text-status-error" aria-hidden="true" />
            </div>
            <h2 id={titleId} className="text-[length:var(--text-lg)] font-semibold text-text-primary">
              Delete &ldquo;{group.name}&rdquo;?
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
            {hostCount === 0
              ? "This empty group will be permanently removed."
              : `This group contains ${hostCount} ${hostCount === 1 ? "host" : "hosts"}.`}
          </p>

          {/* Checkbox — only shown when the group has hosts */}
          {hostCount > 0 && (
            <label className={[
              "flex items-start gap-2.5 cursor-pointer rounded-lg px-3 py-2.5",
              "bg-bg-subtle border border-border",
              "hover:border-border-focus transition-colors duration-[var(--duration-fast)]",
            ].join(" ")}>
              <input
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

        {/* Footer */}
        <div className="px-6 pb-5 pt-3 flex items-center justify-end gap-2 border-t border-border shrink-0">
          <button
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-[length:var(--text-sm)] font-medium text-text-secondary hover:text-text-primary rounded-lg transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(deleteHosts)}
            className="px-4 py-2 text-[length:var(--text-sm)] font-medium text-text-inverse bg-status-error hover:opacity-90 active:opacity-80 rounded-lg transition-opacity duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
