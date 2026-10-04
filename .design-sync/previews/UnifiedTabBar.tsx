import { UnifiedTabBar, useSessionStore, useTabStore } from "anyscp";

// Shared store state: Hosts page + two terminal tabs (one split, connected; one
// connecting) + SFTP + S3, with the split terminal active (which
// also shows the Snippets button on the right).
const hc = (host: string, username: string) => ({ host, port: 22, username, auth_method: { type: "privateKey" as const, key_path: "~/.ssh/id_ed25519" } });
useSessionStore.setState({
  sessions: new Map([
    ["s-api", { id: "s-api", label: "api-prod-01", status: "Connected", hostConfig: hc("10.0.4.21", "deploy") }],
    ["s-api-2", { id: "s-api-2", label: "api-prod-01", status: "Connected", hostConfig: hc("10.0.4.21", "deploy") }],
    ["s-web", { id: "s-web", label: "web-staging", status: "Connecting", hostConfig: hc("staging.acme.dev", "ubuntu") }],
  ]),
  tabs: new Map([
    ["s-api", { label: "api-prod-01", layout: { type: "split", direction: "horizontal", ratio: 0.5, children: [{ type: "pane", sessionId: "s-api" }, { type: "pane", sessionId: "s-api-2" }] } }],
    ["s-web", { label: "web-staging", layout: { type: "pane", sessionId: "s-web" } }],
  ]),
  activeSessionId: "s-api",
  activeTerminalTabId: "s-api",
});
const tabs = [
  { type: "page", id: "page:hosts", label: "Hosts", page: "hosts" },
  { type: "terminal", id: "s-api", label: "api-prod-01" },
  { type: "terminal", id: "s-web", label: "web-staging" },
  { type: "sftp", id: "sftp-db", label: "db-replica" },
  { type: "s3", id: "s3-assets", label: "static-assets" },
] as const;
useTabStore.setState({
  tabs: new Map(tabs.map((t) => [t.id, t])),
  tabOrder: tabs.map((t) => t.id),
  activeTabId: "s-api",
});

export const MixedSessions = () => (
  <div className="bg-bg-base" style={{ width: 870 }}>
    <UnifiedTabBar />
  </div>
);

export const Overflowing = () => (
  <div className="bg-bg-base" style={{ width: 520 }}>
    <UnifiedTabBar />
  </div>
);
