import { PaneHeader, useSessionStore } from "anyscp";
import { Surface } from "./_fixtures";

// PaneHeader reads the global session store. The active terminal tab is a
// split, so split / zoom / close actions are all in play.
const cfg = (host: string, username: string) => ({
  host, port: 22, username, auth_method: { type: "privateKey" as const, key_path: "~/.ssh/id_ed25519" },
});
const sess = (id: string, host: string, username: string, status: "Connected" | "Connecting" | "Error" | "Disconnected") =>
  [id, { id, label: `${username}@${host}`, status, hostConfig: cfg(host, username) }] as const;

useSessionStore.setState({
  sessions: new Map([
    sess("s-api", "api-prod-01.acme.dev", "deploy", "Connected"),
    sess("s-logs", "logs-01.acme.dev", "deploy", "Connected"),
    sess("s-web", "staging.acme.dev", "ubuntu", "Connecting"),
    sess("s-db", "10.0.6.8", "postgres", "Error"),
  ]),
  tabs: new Map([
    ["t-1", {
      label: "deploy@api-prod-01.acme.dev",
      layout: {
        type: "split", direction: "horizontal", ratio: 0.5,
        children: [{ type: "pane", sessionId: "s-api" }, { type: "pane", sessionId: "s-logs" }],
      },
    }],
  ]),
  activeTerminalTabId: "t-1",
  activeSessionId: "s-api",
  zoomedPaneId: null,
});

const Pane = ({ id }: { id: string }) => (
  <Surface width={520} pad={12}>
    <div className="group/pane rounded-lg overflow-hidden border border-border/60">
      <PaneHeader sessionId={id} tabId="t-1" />
      <div className="h-10 bg-bg-base" />
    </div>
  </Surface>
);

export const ActivePane = () => <Pane id="s-api" />;
export const InactivePane = () => <Pane id="s-logs" />;
export const Connecting = () => <Pane id="s-web" />;
export const ConnectionError = () => <Pane id="s-db" />;
