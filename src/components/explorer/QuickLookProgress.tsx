import { LoaderCircle, X } from "lucide-react";
import type { PreviewProgress } from "../../lib/quick-look";
import { formatBytes } from "../../utils/format";

export function QuickLookProgress({ state, onCancel }: { state: PreviewProgress | null; onCancel: () => void }) {
  if (!state) return null;
  return (
    <div role="status" className="flex items-center gap-2 px-4 py-2 border-b border-border bg-bg-surface text-text-secondary text-[length:var(--text-sm)]">
      <LoaderCircle size={15} className="animate-spin shrink-0" aria-hidden="true" />
      <span className="truncate">{state.phase === "preparing" ? "Preparing" : "Downloading"} “{state.fileName}” for Quick Look…</span>
      {state.phase === "downloading" && <span className="shrink-0 tabular-nums">{formatBytes(state.bytesReceived)}{state.totalBytes != null ? ` / ${formatBytes(state.totalBytes)}` : ""}</span>}
      {state.totalBytes != null && state.totalBytes > 0 && <progress className="w-20 shrink-0" aria-label="Preview download progress" value={state.bytesReceived} max={state.totalBytes} />}
      <button type="button" onClick={onCancel} aria-label="Cancel Quick Look" className="ml-auto p-1 rounded hover:bg-bg-subtle"><X size={15} /></button>
    </div>
  );
}
