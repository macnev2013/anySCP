import { PortForwardingPage, mockTauri } from "anyscp";
import type { PortForwardRule, TunnelStatus } from "../../src/types";
import { HOSTS } from "./_fixtures";

// The page loads rules, active tunnels and hosts on mount, so all three are
// served through the Tauri mock.
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const rule = (p: Partial<PortForwardRule> & Pick<PortForwardRule, "id" | "host_id" | "label" | "local_port" | "remote_port">): PortForwardRule => ({
  description: null, forward_type: "Local", bind_address: "127.0.0.1", remote_host: "localhost",
  auto_start: false, enabled: true, last_used_at: null, total_bytes: 0, created_at: ago(60), ...p,
});
const RULES: PortForwardRule[] = [
  rule({ id: "r-pg", host_id: "h-db", label: "Postgres replica", local_port: 15432, remote_port: 5432, auto_start: true }),
  rule({ id: "r-pgadmin", host_id: "h-db", label: "pgAdmin", local_port: 5050, remote_port: 80, last_used_at: ago(6) }),
  rule({ id: "r-redis", host_id: "h-api", label: "Redis", local_port: 6380, remote_port: 6379, remote_host: "redis.internal" }),
  rule({ id: "r-grafana", host_id: "h-api", label: "Grafana", local_port: 3000, remote_port: 3000, last_used_at: ago(2) }),
  rule({ id: "r-metrics", host_id: "h-api", label: "Prometheus", local_port: 9090, remote_port: 9090 }),
  rule({ id: "r-k8s", host_id: "h-bastion", label: "k8s API server", local_port: 6443, remote_port: 6443, remote_host: "10.0.0.10", auto_start: true }),
  rule({ id: "r-es", host_id: "h-bastion", label: "Elasticsearch", local_port: 9200, remote_port: 9200, remote_host: "es-01.internal" }),
];
const TUNNELS: TunnelStatus[] = [
  { rule_id: "r-pg", status: "Active", local_port: 15432, connections: 3, error: null },
  { rule_id: "r-grafana", status: "Active", local_port: 3000, connections: 1, error: null },
  { rule_id: "r-k8s", status: "Starting", local_port: 6443, connections: 0, error: null },
  { rule_id: "r-es", status: "Error", local_port: 9200, connections: 0, error: "bind 127.0.0.1:9200: address already in use" },
];
mockTauri({ pf_list_rules: RULES, pf_list_active_tunnels: TUNNELS, list_hosts: HOSTS });

export const Tunnels = () => (
  <div style={{ width: 1232, height: 752 }}>
    <PortForwardingPage />
  </div>
);
