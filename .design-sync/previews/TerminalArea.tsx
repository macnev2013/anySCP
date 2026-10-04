import { TerminalArea, useSessionStore, useTerminalSearchStore } from "anyscp";
import type { LayoutNode } from "../../src/types";

// A terminal tab split three ways: api shell | (log tail / db shell that dropped).
// xterm buffers are empty in previews (no live shell); pane chrome is real.
const cfg = (host: string, username: string) => ({
  host, port: 22, username, auth_method: { type: "privateKey" as const, key_path: "~/.ssh/id_ed25519" },
});
const sess = (id: string, host: string, username: string, status: "Connected" | "Disconnected") =>
  [id, { id, label: `${username}@${host}`, status, hostConfig: cfg(host, username) }] as const;

const LAYOUT: LayoutNode = {
  type: "split", direction: "horizontal", ratio: 0.55,
  children: [
    { type: "pane", sessionId: "s-api" },
    {
      type: "split", direction: "vertical", ratio: 0.5,
      children: [{ type: "pane", sessionId: "s-logs" }, { type: "pane", sessionId: "s-db" }],
    },
  ],
};

useSessionStore.setState({
  sessions: new Map([
    sess("s-api", "api-prod-01.acme.dev", "deploy", "Connected"),
    sess("s-logs", "logs-01.acme.dev", "deploy", "Connected"),
    sess("s-db", "10.0.6.8", "postgres", "Disconnected"),
  ]),
  tabs: new Map([["s-api", { label: "deploy@api-prod-01.acme.dev", layout: LAYOUT }]]),
  activeTerminalTabId: "s-api",
  activeSessionId: "s-api",
  zoomedPaneId: null,
});
useTerminalSearchStore.setState({
  openSessions: new Set(["s-logs"]),
  queries: new Map([["s-logs", "502"]]),
  results: new Map([["s-logs", { index: 1, count: 3 }]]),
});

export const ThreeWaySplit = () => (
  <div className="bg-bg-base p-1.5" style={{ width: 1232, height: 752 }}>
    <TerminalArea node={LAYOUT} tabId="s-api" />
  </div>
);
