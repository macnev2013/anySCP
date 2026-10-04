import { TransferRow, useTransferStore } from "anyscp";
import type { TransferEvent } from "../../src/types";
import { noop, Surface } from "./_fixtures";

const MB = 1024 * 1024;
const now = Date.now();
const xfer = (p: Partial<TransferEvent> & Pick<TransferEvent, "transfer_id" | "name" | "direction" | "status">): TransferEvent => ({
  sftp_session_id: "sftp-api", error: null, bytes_transferred: 0, total_bytes: 0, files_done: 0, files_total: 1,
  speed_bps: 0, eta_secs: null, created_at: now, ...p,
});

const TRANSFERS: TransferEvent[] = [
  xfer({ transfer_id: "t-1", name: "app-release-2026.10.03.tar.gz", direction: "Upload", status: "InProgress", bytes_transferred: 148 * MB, total_bytes: 412 * MB, speed_bps: 11.6 * MB, eta_secs: 23 }),
  xfer({ transfer_id: "t-2", name: "nginx", direction: "Download", status: "InProgress", sftp_session_id: "sftp-web", bytes_transferred: 3.1 * MB, total_bytes: 4.4 * MB, files_done: 31, files_total: 44, speed_bps: 860 * 1024, eta_secs: 2 }),
  xfer({ transfer_id: "t-3", name: "access.log.2.gz", direction: "Download", status: "Queued", total_bytes: 26 * MB }),
  xfer({ transfer_id: "t-4", name: "assets", direction: "Upload", status: "Queued", s3_session_id: "s3-media", sftp_session_id: undefined, files_total: 128 }),
  xfer({ transfer_id: "t-5", name: "pg_dump-app_production.sql.gz", direction: "Download", status: "Completed", sftp_session_id: "sftp-db", bytes_transferred: 1.9 * 1024 * MB, total_bytes: 1.9 * 1024 * MB }),
  xfer({ transfer_id: "t-6", name: "docker-compose.yml", direction: "Upload", status: { Failed: "Permission denied: /etc/app/docker-compose.yml" }, bytes_transferred: 0, total_bytes: 3.2 * 1024 }),
  xfer({ transfer_id: "t-7", name: "core.dump", direction: "Download", status: "Cancelled", bytes_transferred: 210 * MB, total_bytes: 880 * MB }),
];

const HOST_LABELS = new Map([
  ["sftp-api", "api-prod-01"], ["sftp-web", "web-staging"], ["sftp-db", "db-replica"], ["s3-media", "s3://acme-media-assets"],
]);

useTransferStore.setState({ hostLabels: HOST_LABELS });
const byId = (id: string) => TRANSFERS.find((t) => t.transfer_id === id)!;
const row = (id: string) => (
  <Surface width={360} pad={0}><div className="bg-bg-surface"><TransferRow transfer={byId(id)} onCancel={noop} onRetry={noop} onDismiss={noop} /></div></Surface>
);

export const Uploading = () => row("t-1");
export const MultiFileDownload = () => row("t-2");
export const Queued = () => row("t-3");
export const Completed = () => row("t-5");
export const Failed = () => row("t-6");
export const Cancelled = () => row("t-7");
