import { HistoryPage, mockTauri, useHostsStore } from "anyscp";
import type { ConnectionHistoryEntry } from "../../src/types";
import { HOSTS } from "./_fixtures";

// SQLite-style UTC timestamp ("YYYY-MM-DD HH:MM:SS", no Z), N minutes ago.
const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString().slice(0, 19).replace("T", " ");
const byId = Object.fromEntries(HOSTS.map((h) => [h.id, h]));
const rows: [string, number][] = [
  ["h-api", 4], ["h-web", 38], ["h-api", 95], ["h-db", 180], ["h-bastion", 260],
  ["h-api", 60 * 26], ["h-mac", 60 * 27], ["h-web", 60 * 30],
  ["h-pi", 60 * 24 * 3], ["h-bastion", 60 * 24 * 3 + 40], ["h-db", 60 * 24 * 4],
];
const HISTORY: ConnectionHistoryEntry[] = rows.map(([hid, m], i) => {
  const h = byId[hid];
  return { id: 100 - i, host_id: h.id, host_label: h.label, host: h.host, port: h.port, username: h.username, connected_at: ago(m) };
});

useHostsStore.setState({ hosts: HOSTS });
mockTauri({ list_hosts: HOSTS, list_connection_history: HISTORY });

export const ConnectionLog = () => (
  <div style={{ width: 1280, height: 800 }}>
    <HistoryPage />
  </div>
);
