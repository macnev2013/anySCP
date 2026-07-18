import { useTransfers } from "../../hooks/use-transfers";
import { TransferList } from "./TransferList";

export function TransfersPage() {
  const { list, activeCount, queuedCount, finishedCount, onCancel, onRetry, onDismiss, onClearFinished } =
    useTransfers();

  const summaryParts: string[] = [];
  if (activeCount > 0) summaryParts.push(`${activeCount} active`);
  if (queuedCount > 0) summaryParts.push(`${queuedCount} queued`);
  if (finishedCount > 0) summaryParts.push(`${finishedCount} done`);

  return (
    <div className="flex flex-col h-full overflow-y-scroll bg-bg-base">
      <div className="max-w-4xl w-full mx-auto px-8 py-8 flex flex-col gap-8">
        {/* Page title */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-[length:var(--text-lg)] font-semibold text-text-primary">Transfers</h1>
            <p className="text-[length:var(--text-xs)] text-text-muted mt-1">
              Active, queued, and completed file transfers across all sessions
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {summaryParts.length > 0 && (
              <span className="text-[length:var(--text-2xs)] text-text-muted tabular-nums">
                {summaryParts.join(" · ")}
              </span>
            )}
            {finishedCount > 0 && (
              <button
                onClick={onClearFinished}
                className="px-3 py-1.5 rounded-md text-[length:var(--text-xs)] font-medium text-text-secondary hover:text-text-primary bg-bg-subtle hover:bg-bg-muted border border-border transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Clear completed
              </button>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-border/60 overflow-hidden">
          <TransferList list={list} onCancel={onCancel} onRetry={onRetry} onDismiss={onDismiss} />
        </div>
      </div>
    </div>
  );
}
