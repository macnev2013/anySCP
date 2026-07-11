import type { TransferEvent } from "../../types";
import { TransferRow } from "./TransferRow";

interface TransferListProps {
  list: TransferEvent[];
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
  /** Caps height and scrolls internally (the popover). Omit on the full page,
   *  which lets the rows flow and the page itself scroll. */
  maxHeight?: string;
}

export function TransferList({ list, onCancel, onRetry, onDismiss, maxHeight }: TransferListProps) {
  if (list.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 gap-2">
        <p className="text-[length:var(--text-xs)] text-text-muted">No transfers</p>
        <p className="text-[length:var(--text-2xs)] text-text-muted/60">
          Drag files onto the explorer to upload
        </p>
      </div>
    );
  }

  return (
    <div
      className={maxHeight ? "overflow-y-auto" : ""}
      style={maxHeight ? { maxHeight } : undefined}
      role="list"
      aria-label="Transfer items"
    >
      {list.map((t) => (
        <TransferRow
          key={t.transfer_id}
          transfer={t}
          onCancel={onCancel}
          onRetry={onRetry}
          onDismiss={onDismiss}
        />
      ))}
    </div>
  );
}
