import { TerminalPane, useSessionStore, useTerminalSearchStore } from "anyscp";

// TerminalPane = PaneHeader + xterm + (search bar / disconnect pill). The xterm
// buffer is empty in previews (no live shell).
const cfg = (host: string, username: string) => ({
  host, port: 22, username, auth_method: { type: "privateKey" as const, key_path: "~/.ssh/id_ed25519" },
});
const sess = (id: string, host: string, username: string, status: "Connected" | "Disconnected" | "Error", statusMessage?: string) =>
  [id, { id, label: `${username}@${host}`, status, statusMessage, hostConfig: cfg(host, username) }] as const;

useSessionStore.setState({
  sessions: new Map([
    sess("s-api", "api-prod-01.acme.dev", "deploy", "Connected"),
    sess("s-logs", "logs-01.acme.dev", "deploy", "Connected"),
    sess("s-web", "staging.acme.dev", "ubuntu", "Disconnected"),
    sess("s-db", "10.0.6.8", "postgres", "Error", "Host key verification failed"),
  ]),
  tabs: new Map([["s-api", { label: "deploy@api-prod-01.acme.dev", layout: { type: "pane", sessionId: "s-api" } }]]),
  activeTerminalTabId: "s-api",
  activeSessionId: "s-api",
  zoomedPaneId: null,
});
useTerminalSearchStore.setState({
  openSessions: new Set(["s-logs"]),
  queries: new Map([["s-logs", "timeout"]]),
  results: new Map([["s-logs", { index: 2, count: 7 }]]),
});

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div className="bg-bg-base p-2 rounded-lg" style={{ width: 680, height: 320 }}>{children}</div>
);

export const Connected = () => <Frame><TerminalPane sessionId="s-api" tabId="s-api" /></Frame>;
export const SearchOpen = () => <Frame><TerminalPane sessionId="s-logs" tabId="s-logs" /></Frame>;
export const Disconnected = () => <Frame><TerminalPane sessionId="s-web" tabId="s-web" /></Frame>;
export const ConnectionError = () => <Frame><TerminalPane sessionId="s-db" tabId="s-db" /></Frame>;
