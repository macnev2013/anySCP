import { RecentConnections } from "anyscp";
import type { RecentConnection } from "../../src/types";
import { Surface, noop } from "./_fixtures";

const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
const rc = (host_id: string, host_label: string, host: string, username: string, mins: number): RecentConnection => ({
  host_id, host_label, host, port: 22, username, connected_at: ago(mins),
});

const RECENT: RecentConnection[] = [
  rc("h-api", "api-prod-01", "10.0.4.21", "deploy", 12),
  rc("h-web", "web-staging", "staging.acme.dev", "ubuntu", 60 * 5),
  rc("h-bastion", "bastion", "bastion.acme.dev", "ops", 60 * 26),
  rc("h-db", "db-replica", "10.0.6.8", "postgres", 60 * 24 * 3),
  rc("h-mac", "build-mac", "mac-mini.local", "ci", 60 * 24 * 9),
];

export const Default = () => (
  <Surface width={720}>
    <RecentConnections connections={RECENT} onConnect={noop} />
  </Surface>
);

export const SingleEntry = () => (
  <Surface width={720}>
    <RecentConnections connections={[rc("x-ad", "", "203.0.113.17", "root", 3)]} onConnect={noop} />
  </Surface>
);
