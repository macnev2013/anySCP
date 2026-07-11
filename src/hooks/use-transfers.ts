import { useMemo, useCallback } from "react";
import { useTransferStore } from "../stores/transfer-store";
import type { TransferEvent, TransferStatusValue } from "../types";
import { getStatusString } from "../utils/format";

function sortPriority(status: TransferStatusValue): number {
  const s = getStatusString(status);
  if (s === "InProgress") return 0;
  if (s === "Queued") return 1;
  return 2;
}

export interface TransfersModel {
  list: TransferEvent[];
  activeCount: number;
  queuedCount: number;
  finishedCount: number;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
  onClearFinished: () => void;
}

/**
 * Transfer list (active first, then queued, then finished) plus the row/clear
 * actions, shared by the transfers popover and the full-page tab so both stay
 * in lockstep. Cancel/retry are dispatched to the owning backend, inferred from
 * which session-id field the transfer carries.
 */
export function useTransfers(): TransfersModel {
  const transfers = useTransferStore((s) => s.transfers);
  const removeTransfer = useTransferStore((s) => s.removeTransfer);
  const clearFinished = useTransferStore((s) => s.clearFinished);

  const { list, activeCount, queuedCount, finishedCount } = useMemo(() => {
    let active = 0, queued = 0, finished = 0;
    const items: TransferEvent[] = [];
    for (const t of transfers.values()) {
      items.push(t);
      const s = getStatusString(t.status);
      if (s === "InProgress") active++;
      else if (s === "Queued") queued++;
      else if (s === "Completed" || s === "Failed" || s === "Cancelled") finished++;
    }
    items.sort((a, b) => sortPriority(a.status) - sortPriority(b.status));
    return { list: items, activeCount: active, queuedCount: queued, finishedCount: finished };
  }, [transfers]);

  const protocolOf = useCallback((id: string): "s3" | "scp" | "sftp" => {
    const t = transfers.get(id);
    if (t?.s3_session_id) return "s3";
    if (t?.scp_session_id) return "scp";
    return "sftp";
  }, [transfers]);

  const onCancel = useCallback((id: string) => {
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke(`${protocolOf(id)}_cancel_transfer`, { transferId: id });
      } catch {
        removeTransfer(id);
      }
    })();
  }, [removeTransfer, protocolOf]);

  const onRetry = useCallback((id: string) => {
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke(`${protocolOf(id)}_retry_transfer`, { transferId: id });
      } catch { /* best-effort */ }
    })();
  }, [protocolOf]);

  const onDismiss = useCallback((id: string) => removeTransfer(id), [removeTransfer]);

  const onClearFinished = useCallback(() => {
    clearFinished();
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("sftp_clear_finished_transfers");
        await invoke("scp_clear_finished_transfers");
        await invoke("s3_clear_finished_transfers");
      } catch { /* best-effort */ }
    })();
  }, [clearFinished]);

  return { list, activeCount, queuedCount, finishedCount, onCancel, onRetry, onDismiss, onClearFinished };
}
