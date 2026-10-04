import { SplitContainer, useSessionStore } from "anyscp";
import type { SplitNode } from "../../src/types";
import { SHELL, ShellReplay } from "./_fixtures";

// Terminal output is replayed through the Tauri mock (ShellReplay).
const cfg = (host: string, username: string) => ({
  host, port: 22, username, auth_method: { type: "privateKey" as const, key_path: "~/.ssh/id_ed25519" },
});
const sess = (id: string, host: string, username: string) =>
  [id, { id, label: `${username}@${host}`, status: "Connected" as const, hostConfig: cfg(host, username) }] as const;

const SIDE_BY_SIDE: SplitNode = {
  type: "split", direction: "horizontal", ratio: 0.5,
  children: [{ type: "pane", sessionId: "s-api" }, { type: "pane", sessionId: "s-logs" }],
};
const STACKED: SplitNode = {
  type: "split", direction: "vertical", ratio: 0.6,
  children: [{ type: "pane", sessionId: "s-web" }, { type: "pane", sessionId: "s-db" }],
};

useSessionStore.setState({
  sessions: new Map([
    sess("s-api", "api-prod-01.acme.dev", "deploy"),
    sess("s-logs", "logs-01.acme.dev", "deploy"),
    sess("s-web", "staging.acme.dev", "ubuntu"),
    sess("s-db", "10.0.6.8", "postgres"),
  ]),
  tabs: new Map([
    ["s-api", { label: "deploy@api-prod-01.acme.dev", layout: SIDE_BY_SIDE }],
    ["s-web", { label: "ubuntu@staging.acme.dev", layout: STACKED }],
  ]),
  activeTerminalTabId: "s-api",
  activeSessionId: "s-api",
  zoomedPaneId: null,
});

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div className="bg-bg-base p-1.5" style={{ width: 1232, height: 752 }}>
    <ShellReplay outputs={{ "s-api": SHELL.api, "s-logs": SHELL.logs, "s-web": SHELL.web, "s-db": SHELL.db }} />
    {children}
  </div>
);

export const SideBySide = () => <Frame><SplitContainer node={SIDE_BY_SIDE} path={[]} tabId="s-api" /></Frame>;
export const Stacked = () => <Frame><SplitContainer node={STACKED} path={[]} tabId="s-web" /></Frame>;
