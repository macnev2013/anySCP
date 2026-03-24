export type SessionId = string;

export type AuthMethod =
  | { type: "password"; password: string }
  | { type: "privateKey"; key_path: string; passphrase?: string }
  | { type: "privateKeyData"; key_data: string; passphrase?: string };

export interface HostConfig {
  host: string;
  port: number;
  username: string;
  auth_method: AuthMethod;
  label?: string;
  keep_alive_interval?: number;
  default_shell?: string;
  startup_command?: string;
}

export type ConnectionStatus =
  | "Connecting"
  | "Connected"
  | "Disconnecting"
  | "Disconnected"
  | "Error";

export interface Session {
  id: SessionId;
  hostConfig: HostConfig;
  status: ConnectionStatus;
  statusMessage?: string;
  label: string;
}

export interface SshOutputPayload {
  session_id: string;
  data: number[];
}

export interface SshStatusPayload {
  session_id: string;
  status: { status: ConnectionStatus; message?: string };
}

export interface HostGroup {
  id: string;
  name: string;
  color: string;
  icon: string | null;
  sort_order: number;
  default_username: string | null;
  created_at: string;
  updated_at: string;
}

export interface SavedHost {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  auth_type: string; // "password" | "privateKey" | "privateKeyData"
  group_id: string | null;
  created_at: string;
  updated_at: string;
  // Extended fields
  key_path: string | null;
  color: string | null;
  notes: string | null;
  environment: string | null;          // "production" | "staging" | "dev" | "testing"
  os_type: string | null;              // "linux" | "macos" | "windows" | "freebsd"
  startup_command: string | null;
  proxy_jump: string | null;
  keep_alive_interval: number | null;
  default_shell: string | null;
  font_size: number | null;
  last_connected_at: string | null;
  connection_count: number | null;
}

export interface RecentConnection {
  host_id: string;
  host_label: string;
  host: string;
  port: number;
  username: string;
  connected_at: string;
}

export interface ConnectionHistoryEntry {
  id: number;
  host_id: string;
  host_label: string;
  host: string;
  port: number;
  username: string;
  connected_at: string;
}

export interface SshKeyInfo {
  name: string;
  path: string;
  algorithm: string;
  fingerprint: string;
  has_passphrase: boolean;
}

// ─── SSH Config Import ────────────────────────────────────────────────────────

export interface SshConfigEntry {
  host_alias: string;
  hostname: string | null;
  user: string | null;
  port: number | null;
  identity_file: string | null;
  proxy_jump: string | null;
  keep_alive_interval: number | null;
  is_pattern: boolean;
  already_exists: boolean;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

export type StoredCredential =
  | { type: "Password"; password: string }
  | { type: "KeyPassphrase"; passphrase: string };
