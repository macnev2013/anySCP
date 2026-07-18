import { useEffect, useRef } from "react";
import { X, ExternalLink } from "lucide-react";
import { useTabStore } from "../../stores/tab-store";
import { useTransfers } from "../../hooks/use-transfers";
import { TransferList } from "./TransferList";

// ─── Component ───────────────────────────────────────────────────────────────

interface TransferPopoverProps {
  /** Rect of the trigger button — used to anchor the popover */
  anchorRect: DOMRect | null;
  /** The trigger button, excluded from outside-click so its own toggle owns
   *  the close (otherwise re-clicking it closes then instantly reopens). */
  triggerRef?: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}

export function TransferPopover({ anchorRect, triggerRef, onClose }: TransferPopoverProps) {
  const { list, activeCount, queuedCount, finishedCount, onCancel, onRetry, onDismiss, onClearFinished } =
    useTransfers();
  const openPageTab = useTabStore((s) => s.openPageTab);
  const popoverRef = useRef<HTMLDivElement>(null);

  const handlePopOut = () => {
    openPageTab("transfers", "Transfers");
    onClose();
  };

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        popoverRef.current && !popoverRef.current.contains(target) &&
        !triggerRef?.current?.contains(target)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose, triggerRef]);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // ─── Positioning ────────────────────────────────────────────────────────────

  // Anchor to the right of the trigger, aligned to bottom
  const style: React.CSSProperties = {};
  if (anchorRect) {
    style.position = "fixed";
    style.left = anchorRect.right + 8;
    style.bottom = window.innerHeight - anchorRect.bottom;
    style.zIndex = 50;
  }

  // ─── Summary text ───────────────────────────────────────────────────────────

  const summaryParts: string[] = [];
  if (activeCount > 0) summaryParts.push(`${activeCount} active`);
  if (queuedCount > 0) summaryParts.push(`${queuedCount} queued`);
  if (finishedCount > 0) summaryParts.push(`${finishedCount} done`);

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Transfers"
      style={style}
      className={[
        "w-[340px] flex flex-col",
        "bg-bg-surface border border-border rounded-xl",
        "shadow-[var(--shadow-lg)]",
        "animate-[fadeIn_120ms_var(--ease-expo-out)_both]",
      ].join(" ")}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-border/60 shrink-0">
        <span className="text-[length:var(--text-xs)] font-semibold text-text-primary">
          Transfers
        </span>

        {summaryParts.length > 0 && (
          <span className="text-[length:var(--text-2xs)] text-text-muted tabular-nums">
            {summaryParts.join(" \u00b7 ")}
          </span>
        )}

        <span className="flex-1" />

        {/* Clear finished */}
        {finishedCount > 0 && (
          <button
            onClick={onClearFinished}
            title="Clear completed transfers"
            aria-label="Clear completed transfers"
            className={[
              "flex items-center gap-1 px-2 py-1 rounded-md",
              "text-[length:var(--text-2xs)] font-medium",
              "text-text-muted hover:text-text-secondary hover:bg-bg-subtle",
              "transition-colors duration-[var(--duration-fast)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            ].join(" ")}
          >
            Clear
          </button>
        )}

        {/* Open the full-page view */}
        <button
          onClick={handlePopOut}
          title="Open in a tab"
          aria-label="Open transfers in a tab"
          className={[
            "flex items-center justify-center w-7 h-7 rounded-md",
            "text-text-muted hover:text-text-primary hover:bg-bg-subtle",
            "transition-colors duration-[var(--duration-fast)]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          ].join(" ")}
        >
          <ExternalLink size={14} strokeWidth={2} aria-hidden="true" />
        </button>

        {/* Close */}
        <button
          onClick={onClose}
          title="Close"
          aria-label="Close transfers"
          className={[
            "flex items-center justify-center w-7 h-7 rounded-md",
            "text-text-muted hover:text-text-primary hover:bg-bg-subtle",
            "transition-colors duration-[var(--duration-fast)]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          ].join(" ")}
        >
          <X size={15} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      {/* Transfer list */}
      <TransferList
        list={list}
        onCancel={onCancel}
        onRetry={onRetry}
        onDismiss={onDismiss}
        maxHeight="min(400px, 50vh)"
      />
    </div>
  );
}
