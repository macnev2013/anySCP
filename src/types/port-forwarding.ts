export interface PortForwardRule {
  id: string;
  host_id: string | null;
  label: string | null;
  description: string | null;
  forward_type: "Local" | "Remote";
  bind_address: string;
  local_port: number;
  remote_host: string;
  remote_port: number;
  auto_start: boolean;
  enabled: boolean;
  last_used_at: string | null;
  total_bytes: number;
  created_at: string;
}

export interface TunnelStatus {
  rule_id: string;
  status: "Starting" | "Active" | "Error" | "Stopped";
  local_port: number;
  connections: number;
  error: string | null;
}
