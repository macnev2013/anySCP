import { AppShell, mockTauri, useTabStore } from "anyscp";
import type { HostGroup, RecentConnection } from "../../src/types";
import { HOSTS } from "./_fixtures";

// Full app chrome on the Hosts page: collapsed sidebar rail, tab bar with a
// couple of open page tabs, and the dashboard (loaded through the Tauri mock).
const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
const GROUPS: HostGroup[] = [
  { id: "g-prod", name: "Production", color: "#ef4444", icon: "Server", sort_order: 0, default_username: "deploy", created_at: ago(90000), updated_at: ago(3000) },
  { id: "g-stage", name: "Staging", color: "#f59e0b", icon: "Rocket", sort_order: 1, default_username: "ubuntu", created_at: ago(90000), updated_at: ago(3000) },
];
const RECENT: RecentConnection[] = [
  { host_id: "h-api", host_label: "api-prod-01", host: "10.0.4.21", port: 22, username: "deploy", connected_at: ago(12) },
  { host_id: "h-web", host_label: "web-staging", host: "staging.acme.dev", port: 22, username: "ubuntu", connected_at: ago(300) },
];
mockTauri({ list_hosts: HOSTS, list_groups: GROUPS, list_recent_connections: RECENT });

useTabStore.setState({
  tabs: new Map([
    ["page:hosts", { type: "page", id: "page:hosts", label: "Hosts", page: "hosts" }],
    ["page:snippets", { type: "page", id: "page:snippets", label: "Snippets", page: "snippets" }],
    ["page:history", { type: "page", id: "page:history", label: "History", page: "history" }],
  ]),
  tabOrder: ["page:hosts", "page:snippets", "page:history"],
  activeTabId: "page:hosts",
});

// AppShell's root is h-screen/w-screen; the capture frame insets the cell by
// 24px, so pin the root to the wrapper to keep the whole chrome in view.
export const HostsHome = () => (
  <div className="appshell-frame" style={{ width: 1256, height: 776, overflow: "hidden" }}>
    <style>{`.appshell-frame > div { width: 100% !important; height: 100% !important; }`}</style>
    <AppShell />
  </div>
);
