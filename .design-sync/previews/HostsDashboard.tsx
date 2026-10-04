import { HostsDashboard, mockTauri } from "anyscp";
import type { HostGroup, RecentConnection, S3Connection } from "../../src/types";
import { HOSTS } from "./_fixtures";

// HostsDashboard loads hosts, groups, recents and S3 connections via invoke on
// mount, so the data is served through the Tauri mock rather than store seeds.
const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();

const GROUPS: HostGroup[] = [
  { id: "g-prod", name: "Production", color: "#ef4444", icon: "Server", sort_order: 0, default_username: "deploy", created_at: ago(90000), updated_at: ago(3000) },
  { id: "g-stage", name: "Staging", color: "#f59e0b", icon: "Rocket", sort_order: 1, default_username: "ubuntu", created_at: ago(90000), updated_at: ago(3000) },
  { id: "g-lab", name: "Homelab", color: "#22c55e", icon: "Home", sort_order: 2, default_username: null, created_at: ago(90000), updated_at: ago(3000) },
];

const RECENT: RecentConnection[] = [
  { host_id: "h-api", host_label: "api-prod-01", host: "10.0.4.21", port: 22, username: "deploy", connected_at: ago(12) },
  { host_id: "h-web", host_label: "web-staging", host: "staging.acme.dev", port: 22, username: "ubuntu", connected_at: ago(300) },
  { host_id: "h-bastion", host_label: "bastion", host: "bastion.acme.dev", port: 22, username: "ops", connected_at: ago(1560) },
];

const S3: S3Connection[] = [
  { id: "s3-assets", label: "acme-static-assets", provider: "aws", region: "us-east-1", endpoint: null, bucket: "acme-static-assets", path_style: false, group_id: null, color: null, environment: "production", notes: null, created_at: ago(40000) },
  { id: "s3-backups", label: "db-backups", provider: "r2", region: "auto", endpoint: "https://8f2c.r2.cloudflarestorage.com", bucket: "pg-nightly-backups", path_style: false, group_id: null, color: null, environment: null, notes: null, created_at: ago(20000) },
];

mockTauri({
  list_hosts: HOSTS,
  list_groups: GROUPS,
  list_recent_connections: RECENT,
  s3_list_connections: S3,
});

export const SavedHosts = () => (
  <div style={{ width: 1280, height: 800 }}>
    <HostsDashboard />
  </div>
);
