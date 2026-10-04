import { StatusBar, useSessionStore } from "anyscp";

// StatusBar reads the global session store, so every cell shares one state:
// an active, connected session with two sessions open.
const mk = (id: string, host: string, username: string, status: "Connected" | "Connecting") => ({
  id,
  label: host,
  status,
  hostConfig: { host, port: 22, username, auth_method: { type: "privateKey" as const, key_path: "~/.ssh/id_ed25519" } },
});
useSessionStore.setState({
  sessions: new Map([
    ["s1", mk("s1", "api-prod-01.acme.dev", "deploy", "Connected")],
    ["s2", mk("s2", "staging.acme.dev", "ubuntu", "Connecting")],
  ]),
  activeSessionId: "s1",
});

export const ActiveSession = () => (
  <div style={{ width: 720 }}>
    <StatusBar />
  </div>
);
