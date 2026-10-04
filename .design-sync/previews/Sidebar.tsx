import { Sidebar, useTabStore, useTransferStore, useUiStore } from "anyscp";
import type { TransferEvent } from "../../src/types";

// Sidebar reads ui (expanded), tab (active page) and transfer (badge) stores;
// every cell shares this state: expanded rail, Snippets active, 2 active transfers.
const t = (id: string, name: string, status: TransferEvent["status"], done: number, total: number): TransferEvent => ({
  transfer_id: id, sftp_session_id: "sftp-1", name, direction: "Download", status, error: null,
  bytes_transferred: done, total_bytes: total, files_done: 0, files_total: 1, speed_bps: 4_200_000, eta_secs: 12, created_at: Date.now(),
});
useUiStore.setState({ sidebarExpanded: true });
useTabStore.setState({
  tabs: new Map([
    ["page:hosts", { type: "page", id: "page:hosts", label: "Hosts", page: "hosts" }],
    ["page:snippets", { type: "page", id: "page:snippets", label: "Snippets", page: "snippets" }],
  ]),
  tabOrder: ["page:hosts", "page:snippets"],
  activeTabId: "page:snippets",
});
useTransferStore.setState({
  transfers: new Map([
    ["t1", t("t1", "access.log.2.gz", "InProgress", 38_000_000, 92_000_000)],
    ["t2", t("t2", "pg_dump_2026-10-03.sql", "Queued", 0, 1_400_000_000)],
    ["t3", t("t3", "nginx.conf", "Completed", 4_096, 4_096)],
  ]),
});

export const ExpandedRail = () => (
  <div className="bg-bg-base" style={{ width: 240, height: 560, display: "flex" }}>
    <Sidebar />
  </div>
);
