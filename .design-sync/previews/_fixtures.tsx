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
