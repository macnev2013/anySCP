// Shared realistic data for anySCP previews (not a component preview itself).
import type { SavedHost } from "../../src/types";

const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();

export function host(partial: Partial<SavedHost> & Pick<SavedHost, "id" | "label" | "host">): SavedHost {
  return {
    port: 22,
    username: "deploy",
    auth_type: "privateKey",
    group_id: null,
    created_at: ago(60 * 24 * 30),
    updated_at: ago(60 * 24 * 2),
    key_path: "~/.ssh/id_ed25519",
    color: null,
    notes: null,
    environment: null,
    os_type: "linux",
    startup_command: null,
    proxy_jump: null,
    proxy_jump_host_id: null,
    start_directory: null,
    keep_alive_interval: 30,
    default_shell: null,
    font_size: null,
    last_connected_at: null,
    connection_count: 0,
    ...partial,
  };
}

export const HOSTS: SavedHost[] = [
  host({ id: "h-api", label: "api-prod-01", host: "10.0.4.21", environment: "production", last_connected_at: ago(12), connection_count: 48, group_id: "g-prod" }),
  host({ id: "h-web", label: "web-staging", host: "staging.acme.dev", environment: "staging", username: "ubuntu", last_connected_at: ago(60 * 5), connection_count: 17, group_id: "g-stage" }),
  host({ id: "h-bastion", label: "bastion", host: "bastion.acme.dev", username: "ops", last_connected_at: ago(60 * 26), connection_count: 112 }),
  host({ id: "h-db", label: "db-replica", host: "10.0.6.8", environment: "production", proxy_jump_host_id: "h-bastion", username: "postgres", last_connected_at: ago(60 * 24 * 3), group_id: "g-prod" }),
  host({ id: "h-pi", label: "homelab-pi", host: "192.168.1.40", environment: "dev", username: "pi", os_type: "linux", color: "#22c55e" }),
  host({ id: "h-mac", label: "build-mac", host: "mac-mini.local", environment: "testing", username: "ci", os_type: "macos", last_connected_at: ago(60 * 24 * 9) }),
];

export const noop = () => {};

/** The app's base surface (dark theme): what every screen sits on. */
export function Surface({ children, width, pad = 16 }: { children: React.ReactNode; width?: number; pad?: number }) {
  return (
    <div className="bg-bg-base text-text-primary font-sans" style={{ padding: pad, width, borderRadius: 8, display: width ? "block" : "inline-block" }}>
      {children}
    </div>
  );
}

// ─── Terminal output replay ────────────────────────────────────────────────
// xterm renders only what the backend streams on "ssh:output"; previews replay
// canned ANSI sessions through the Tauri mock (emitTauriEvent from "anyscp").
import { useEffect as useEffectFx } from "react";
import { emitTauriEvent } from "anyscp";

const E = { g: "\x1b[32m", b: "\x1b[34m", c: "\x1b[36m", y: "\x1b[33m", r: "\x1b[31m", bold: "\x1b[1m", x: "\x1b[0m" };
const ps1 = (user: string, host: string, dir = "~") => `${E.bold}${E.g}${user}@${host}${E.x}:${E.bold}${E.b}${dir}${E.x}$ `;

export const SHELL = {
  api: [
    `${ps1("deploy", "api-prod-01", "~/app")}git log --oneline -3`,
    `${E.y}9f2c1e4${E.x} Bump rate limiter to 300 rps`,
    `${E.y}41ab07d${E.x} Add /healthz readiness probe`,
    `${E.y}c3d9a12${E.x} Rotate TLS certs`,
    `${ps1("deploy", "api-prod-01", "~/app")}uptime`,
    " 09:14:52 up 11 days,  3:41,  2 users,  load average: 0.42, 0.37, 0.31",
    ps1("deploy", "api-prod-01", "~/app"),
  ].join("\r\n"),
  logs: [
    `${ps1("deploy", "logs-01", "/var/log/nginx")}tail -f access.log`,
    `10.0.1.17 - - [01/Oct/2024:09:14:02] "GET /api/v2/orders HTTP/1.1" 200 1843`,
    `10.0.1.22 - - [01/Oct/2024:09:14:03] "POST /api/v2/checkout HTTP/1.1" ${E.r}502${E.x} 166`,
    `10.0.1.17 - - [01/Oct/2024:09:14:05] "GET /healthz HTTP/1.1" 200 2`,
    `10.0.1.31 - - [01/Oct/2024:09:14:07] "GET /api/v2/orders?page=2 HTTP/1.1" 200 1720`,
    `10.0.1.22 - - [01/Oct/2024:09:14:09] "POST /api/v2/checkout HTTP/1.1" ${E.r}502${E.x} 166`,
  ].join("\r\n"),
  web: [
    `${ps1("ubuntu", "web-staging")}docker ps --format 'table {{.Names}}\\t{{.Status}}'`,
    "NAMES          STATUS",
    `web            ${E.g}Up 2 hours${E.x}`,
    `worker         ${E.g}Up 2 hours${E.x}`,
    `redis          ${E.g}Up 3 days${E.x}`,
    ps1("ubuntu", "web-staging"),
  ].join("\r\n"),
  db: [
    `${ps1("postgres", "db-replica")}psql -c 'select now() - pg_last_xact_replay_timestamp() as lag;'`,
    "       lag",
    "-----------------",
    " 00:00:00.412871",
    "(1 row)",
    "",
    ps1("postgres", "db-replica"),
  ].join("\r\n"),
};

/** Render once inside a preview to stream `outputs[sessionId]` into its terminal. */
export function ShellReplay({ outputs }: { outputs: Record<string, string> }) {
  useEffectFx(() => {
    const t = setTimeout(() => {
      for (const [session_id, text] of Object.entries(outputs)) {
        emitTauriEvent("ssh:output", { session_id, data: Array.from(new TextEncoder().encode(text)) });
      }
    }, 300);
    return () => clearTimeout(t);
  }, [outputs]);
  return null;
}
