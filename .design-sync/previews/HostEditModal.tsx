import { HostEditModal, mockTauri, useUiStore } from "anyscp";
import type { HostGroup, SshKeyInfo } from "../../src/types";
import { HOSTS } from "./_fixtures";

// The modal is driven by useUiStore.editingHostId and fetches the host via
// get_host; editing db-replica shows the SSH-tunnel (jump host) section.
const now = new Date().toISOString();
const GROUPS: HostGroup[] = [
  { id: "g-prod", name: "Production", color: "#ef4444", icon: "Server", sort_order: 0, default_username: "deploy", created_at: now, updated_at: now },
  { id: "g-stage", name: "Staging", color: "#f59e0b", icon: "Rocket", sort_order: 1, default_username: "ubuntu", created_at: now, updated_at: now },
];
const KEYS: SshKeyInfo[] = [
  { name: "id_ed25519", path: "~/.ssh/id_ed25519", algorithm: "ssh-ed25519", fingerprint: "SHA256:q7Xv2m9kL0aYpR4tB8nW3cZ1fE6hJ5sD", has_passphrase: false },
  { name: "acme_deploy_rsa", path: "~/.ssh/acme_deploy_rsa", algorithm: "ssh-rsa", fingerprint: "SHA256:Zt4Nw8eQ2xVb7Lk1Gm9Hc3Rp6Yd0Sj5F", has_passphrase: true },
];

const DB = { ...HOSTS.find((h) => h.id === "h-db")!, notes: "Read replica for analytics; reach via bastion only.", start_directory: "/var/lib/postgresql", group_id: "g-prod" };
const ALL = HOSTS.map((h) => (h.id === DB.id ? DB : h));

mockTauri({
  list_hosts: ALL,
  list_groups: GROUPS,
  list_ssh_keys: KEYS,
  get_host: ({ id }: Record<string, unknown>) => ALL.find((h) => h.id === id) ?? null,
  vault_has_credential: true,
});
useUiStore.setState({ editingHostId: "h-db" });

export const EditHost = () => <div style={{ width: 960, height: 680 }}><HostEditModal /></div>;
