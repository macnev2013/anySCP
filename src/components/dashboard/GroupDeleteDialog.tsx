import { useState, useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";
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
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus the Cancel button on mount for safe default
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [onCancel]);

  const confirmLabel =
    hostCount > 0 && deleteHosts ? "Delete Group & Hosts" : "Delete Group";

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      aria-modal="true"
      role="dialog"
      aria-labelledby="group-delete-title"
      aria-describedby="group-delete-desc"
    >
      {/* Blur overlay */}
      <div
        className="absolute inset-0 bg-bg-base/70 backdrop-blur-sm"
        onClick={onCancel}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        className={[
          "relative z-10 w-full max-w-sm mx-4 p-6 rounded-xl",
          "bg-bg-surface border border-border",
          "shadow-[var(--shadow-lg)]",
        ].join(" ")}
      >
        {/* Header */}
        <div className="flex items-start gap-3 mb-4">
          <div
            className="flex items-center justify-center w-9 h-9 rounded-lg shrink-0"
            style={{ backgroundColor: "oklch(0.650 0.200 25 / 0.12)" }}
          >
            <AlertTriangle
              size={18}
              strokeWidth={1.8}
              className="text-status-error"
              aria-hidden="true"
            />
          </div>
          <div>
            <h2
              id="group-delete-title"
              className="text-[length:var(--text-sm)] font-semibold text-text-primary leading-snug"
            >
              Delete &ldquo;{group.name}&rdquo; group?
            </h2>
            <p
              id="group-delete-desc"
              className="text-[length:var(--text-xs)] text-text-muted mt-0.5"
            >
              {hostCount === 0
                ? "Delete this empty group?"
                : `This group contains ${hostCount} ${hostCount === 1 ? "host" : "hosts"}.`}
            </p>
          </div>
        </div>

        {/* Checkbox — only shown when the group has hosts */}
        {hostCount > 0 && (
          <label
            className={[
              "flex items-start gap-2.5 mb-5 cursor-pointer rounded-lg px-3 py-2.5",
              "bg-bg-overlay border border-border",
              "hover:border-border-focus transition-colors duration-[var(--duration-fast)]",
            ].join(" ")}
          >
            <input
              type="checkbox"
              checked={deleteHosts}
              onChange={(e) => setDeleteHosts(e.target.checked)}
              className={[
                "mt-0.5 h-3.5 w-3.5 rounded shrink-0 cursor-pointer",
                "accent-[oklch(0.650_0.200_25)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              ].join(" ")}
            />
            <span className="text-[length:var(--text-xs)] text-text-secondary leading-snug select-none">
              Also delete all {hostCount} {hostCount === 1 ? "host" : "hosts"} in this group
              <span className="block text-text-muted mt-0.5">
                Unchecked: hosts will be moved out of the group
              </span>
            </span>
          </label>
        )}

        {/* Actions */}
        <div className="flex gap-2 justify-end">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className={[
              "px-4 py-1.5 rounded-lg text-[length:var(--text-sm)] font-medium",
              "text-text-secondary bg-bg-overlay border border-border",
              "hover:text-text-primary hover:border-border-focus hover:bg-bg-subtle",
              "transition-all duration-[var(--duration-fast)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            ].join(" ")}
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(deleteHosts)}
            className={[
              "px-4 py-1.5 rounded-lg text-[length:var(--text-sm)] font-medium",
              "bg-status-error text-text-inverse",
              "hover:opacity-90 active:opacity-80",
              "transition-opacity duration-[var(--duration-fast)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            ].join(" ")}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
