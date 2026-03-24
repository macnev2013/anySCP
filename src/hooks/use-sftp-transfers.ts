import { useEffect } from "react";
import { useTransferStore } from "../stores/transfer-store";
import { useSftpStore } from "../stores/sftp-store";
import { useS3Store } from "../stores/s3-store";
import type { TransferEvent } from "../types";

/**
 * Listens to both `sftp:transfer` and `s3:transfer` Tauri events and keeps
 * the transfer-store up to date. Mount this hook once globally (in AppShell)
 * so transfers persist regardless of which page is visible.
 *
 * On mount it calls both `sftp_list_transfers` and `s3_list_s3_transfers`
 * to hydrate any in-flight transfers.
 */
export function useSftpTransfers() {
  const updateTransfer = useTransferStore((s) => s.updateTransfer);
  const hydrate = useTransferStore((s) => s.hydrate);
  const setPopoverOpen = useTransferStore((s) => s.setPopoverOpen);
  const setHostLabel = useTransferStore((s) => s.setHostLabel);

  // Hydrate on mount — both SFTP and S3
  useEffect(() => {
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");

        // Hydrate SFTP transfers
        try {
          const items = await invoke<TransferEvent[]>("sftp_list_transfers");
          hydrate(items);
        } catch { /* Backend may not have this command yet */ }

        // Hydrate S3 transfers
        try {
          const s3Items = await invoke<TransferEvent[]>("s3_list_transfers");
          hydrate(s3Items);
        } catch { /* Backend may not have this command yet */ }
      } catch { /* Not in Tauri context */ }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for live SFTP transfer events
  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | undefined;

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (aborted) return;

        const unsub = await listen<TransferEvent>("sftp:transfer", (event) => {
          const transfer = event.payload;
          updateTransfer(transfer);

          // Cache the host label for this session
          if (transfer.sftp_session_id) {
            const sftpSession = useSftpStore.getState().sessions.get(transfer.sftp_session_id);
            if (sftpSession) {
              setHostLabel(transfer.sftp_session_id, sftpSession.label);
            }
          }

          // Auto-open popover when a new transfer starts
          if (transfer.status === "InProgress" || transfer.status === "Queued") {
            if (!useTransferStore.getState().popoverOpen) {
              setPopoverOpen(true);
            }
          }
        });

        if (aborted) { unsub(); } else { unlisten = unsub; }
      } catch { /* Tauri API not available */ }
    })();

    return () => { aborted = true; unlisten?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateTransfer, setPopoverOpen, setHostLabel]);

  // Listen for live S3 transfer events
  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | undefined;

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (aborted) return;

        const unsub = await listen<TransferEvent>("s3:transfer", (event) => {
          const transfer = event.payload;
          updateTransfer(transfer);

          // Cache the host label for this session
          if (transfer.s3_session_id) {
            const s3Session = useS3Store.getState().sessions.get(transfer.s3_session_id);
            if (s3Session) {
              setHostLabel(transfer.s3_session_id, s3Session.label);
            }
          }

          // Auto-open popover when a new transfer starts
          if (transfer.status === "InProgress" || transfer.status === "Queued") {
            if (!useTransferStore.getState().popoverOpen) {
              setPopoverOpen(true);
            }
          }
        });

        if (aborted) { unsub(); } else { unlisten = unsub; }
      } catch { /* Tauri API not available */ }
    })();

    return () => { aborted = true; unlisten?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateTransfer, setPopoverOpen, setHostLabel]);
}
