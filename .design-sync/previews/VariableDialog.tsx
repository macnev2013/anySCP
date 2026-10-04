import { VariableDialog, useSessionStore } from "anyscp";
import type { Snippet, SnippetFolder, SnippetVariable } from "../../src/types";
import { noop } from "./_fixtures";

const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
const vars = (v: Partial<SnippetVariable>[]) =>
  JSON.stringify(v.map((x) => ({ label: null, default_value: null, placeholder: null, options: null, required: false, ...x })));
const snip = (p: Partial<Snippet> & Pick<Snippet, "id" | "name" | "command">): Snippet => ({
  description: null, folder_id: null, tags: null, variables: null, is_dangerous: false,
  use_count: 0, last_used_at: null, sort_order: 0, created_at: ago(60 * 24 * 40), updated_at: ago(60 * 24 * 3), ...p,
});

const FOLDERS: SnippetFolder[] = [
  { id: "f-docker", name: "Docker", parent_id: null, color: "oklch(0.700 0.150 250)", icon: null, sort_order: 0, created_at: ago(9000), updated_at: ago(900) },
  { id: "f-nginx", name: "Web Servers", parent_id: null, color: "oklch(0.720 0.180 155)", icon: null, sort_order: 1, created_at: ago(9000), updated_at: ago(900) },
  { id: "f-db", name: "Database", parent_id: null, color: "oklch(0.750 0.160 80)", icon: null, sort_order: 2, created_at: ago(9000), updated_at: ago(900) },
];

const SNIPPETS: Snippet[] = [
  snip({ id: "s-logs", name: "Tail nginx error log", command: "sudo tail -n 200 -f /var/log/nginx/error.log", folder_id: "f-nginx", tags: "nginx, logs", use_count: 42, last_used_at: ago(35) }),
  snip({ id: "s-restart", name: "Restart service", command: "sudo systemctl {{action}} {{service}}", folder_id: "f-nginx", tags: "systemd",
    variables: vars([{ name: "action", label: "Action", default_value: "restart", options: ["start", "stop", "restart", "status"], required: true }, { name: "service", label: "Service name", placeholder: "nginx", required: true }]),
    use_count: 17, last_used_at: ago(60 * 26) }),
  snip({ id: "s-dps", name: "Docker containers", command: "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'", folder_id: "f-docker", tags: "docker", use_count: 63, last_used_at: ago(60 * 3) }),
  snip({ id: "s-prune", name: "Prune docker system", command: "docker system prune -af --volumes", folder_id: "f-docker", tags: "docker, cleanup", is_dangerous: true, use_count: 4, last_used_at: ago(60 * 24 * 12) }),
  snip({ id: "s-dump", name: "Dump database", command: "pg_dump -U {{USER}} -h localhost {{database}} | gzip > /backups/{{database}}-{{DATE}}.sql.gz", folder_id: "f-db", tags: "postgres, backup",
    variables: vars([{ name: "database", label: "Database", default_value: "app_production", required: true }]), use_count: 9, last_used_at: ago(60 * 24 * 2) }),
  snip({ id: "s-disk", name: "Disk usage by directory", command: "du -h --max-depth=1 {{path}} | sort -hr | head -20", tags: "disk",
    variables: vars([{ name: "path", label: "Path", default_value: "/var" }]), use_count: 0 }),
];

const mkSession = (id: string, host: string, username: string) => ({
  id, label: host, status: "Connected" as const,
  hostConfig: { host, port: 22, username, auth_method: { type: "privateKey" as const, key_path: "~/.ssh/id_ed25519" } },
});
useSessionStore.setState({ sessions: new Map([["sess-1", mkSession("sess-1", "api-prod-01.acme.dev", "deploy")]]), activeSessionId: "sess-1" });

const Frame = ({ children }: { children: React.ReactNode }) => <div className="bg-bg-base" style={{ width: 960, height: 680 }}>{children}</div>;

export const SelectAndText = () => <Frame><VariableDialog snippet={SNIPPETS[1]} onExecute={noop} onCancel={noop} /></Frame>;
export const WithBuiltins = () => <Frame><VariableDialog snippet={SNIPPETS[4]} onExecute={noop} onCancel={noop} /></Frame>;
export const DangerousWarning = () => (
  <Frame><VariableDialog
    snippet={snip({ id: "s-rm", name: "Clear release directory", command: "rm -rf /srv/app/releases/{{release}}", is_dangerous: true,
      variables: vars([{ name: "release", label: "Release ID", placeholder: "20261003-1412", required: true }]) })}
    onExecute={noop}
    onCancel={noop}
  /></Frame>
);
