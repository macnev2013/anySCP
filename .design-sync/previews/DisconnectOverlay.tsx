import { DisconnectOverlay } from "anyscp";

const cfg = (host: string, username: string) => ({
  host, port: 22, username, auth_method: { type: "privateKey" as const, key_path: "~/.ssh/id_ed25519" },
});

// Static scrollback stand-in so the pill sits over a terminal, as in the app.
const API_SCROLLBACK = [
  "deploy@api-prod-01:~$ sudo systemctl restart api.service",
  "deploy@api-prod-01:~$ journalctl -u api.service -n 5 --no-pager",
  "Oct 04 09:12:41 api-prod-01 systemd[1]: Stopping api.service - ACME API...",
  "Oct 04 09:12:42 api-prod-01 systemd[1]: api.service: Deactivated successfully.",
  "Oct 04 09:12:42 api-prod-01 systemd[1]: Started api.service - ACME API.",
  "Oct 04 09:12:43 api-prod-01 api[48211]: listening on 0.0.0.0:8080",
  "deploy@api-prod-01:~$ sudo reboot",
  "Connection to api-prod-01.acme.dev closed by remote host.",
];
const DB_SCROLLBACK = [
  "postgres@db-replica:~$ psql -c 'select pg_last_wal_replay_lsn();'",
  " pg_last_wal_replay_lsn",
  "------------------------",
  " 3A/9F0021C8",
  "(1 row)",
  "",
  "postgres@db-replica:~$ exit",
  "logout",
  "Connection to 10.0.6.8 closed.",
];

const TerminalBackdrop = ({ lines, children }: { lines: string[]; children: React.ReactNode }) => (
  <div className="relative bg-bg-base border border-border/60 rounded-lg overflow-hidden" style={{ width: 880, height: 300 }}>
    <pre className="m-0 p-3 font-mono text-[12px] leading-[1.5] text-text-secondary">{lines.join("\n")}</pre>
    {children}
  </div>
);

export const ConnectionLost = () => (
  <TerminalBackdrop lines={API_SCROLLBACK}>
    <DisconnectOverlay sessionId="s-api" tabId="s-api" status="Disconnected" hostConfig={cfg("api-prod-01.acme.dev", "deploy")} />
  </TerminalBackdrop>
);

export const AuthError = () => (
  <TerminalBackdrop lines={DB_SCROLLBACK}>
    <DisconnectOverlay
      sessionId="s-db"
      tabId="s-db"
      status="Error"
      message="Permission denied (publickey)"
      hostConfig={cfg("10.0.6.8", "postgres")}
    />
  </TerminalBackdrop>
);
