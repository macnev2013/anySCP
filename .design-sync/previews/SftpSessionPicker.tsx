import { SftpSessionPicker, useSessionStore } from "anyscp";
import type { Session } from "../../src/types";

const s = (id: string, label: string, host: string, username: string, status: Session["status"]): Session => ({
  id, label, status,
  hostConfig: { host, port: 22, username, auth_method: { type: "privateKey", key_path: "~/.ssh/id_ed25519" } },
});

useSessionStore.setState({
  sessions: new Map([
    ["ssh-api", s("ssh-api", "api-prod-01", "10.0.4.21", "deploy", "Connected")],
    ["ssh-web", s("ssh-web", "web-staging", "staging.acme.dev", "ubuntu", "Connected")],
    ["ssh-bastion", s("ssh-bastion", "bastion", "bastion.acme.dev", "ops", "Connecting")],
    ["ssh-pi", s("ssh-pi", "homelab-pi", "192.168.1.40", "pi", "Connected")],
  ]),
});

export const ActiveSessions = () => (
  <div style={{ width: 720, height: 520 }}><SftpSessionPicker /></div>
);
