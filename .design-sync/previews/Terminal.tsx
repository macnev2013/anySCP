import { Terminal, useSessionStore } from "anyscp";

// xterm.js can't attach to a real shell in the preview, so the canvas shows an
// empty buffer; the cell shows the terminal surface at its real size.
useSessionStore.setState({
  sessions: new Map([["s-api", {
    id: "s-api", label: "deploy@api-prod-01.acme.dev", status: "Connected",
    hostConfig: { host: "api-prod-01.acme.dev", port: 22, username: "deploy", auth_method: { type: "privateKey", key_path: "~/.ssh/id_ed25519" } },
  }]]),
  activeSessionId: "s-api",
});

export const Session = () => (
  <div className="rounded-lg overflow-hidden border border-border/60" style={{ width: 720, height: 360 }}>
    <Terminal sessionId="s-api" />
  </div>
);
