import { ImportSshConfigModal, mockTauri } from "anyscp";
import type { SshConfigEntry } from "../../src/types";
import { noop } from "./_fixtures";

const e = (p: Partial<SshConfigEntry> & Pick<SshConfigEntry, "host_alias">): SshConfigEntry => ({
  hostname: null, user: null, port: null, identity_file: null, proxy_jump: null,
  keep_alive_interval: null, is_pattern: false, already_exists: false, ...p,
});

// The modal scans ~/.ssh/config on mount via import_parse_ssh_config.
mockTauri({
  import_parse_ssh_config: [
    e({ host_alias: "api-prod-01", hostname: "10.0.4.21", user: "deploy", identity_file: "~/.ssh/id_ed25519", already_exists: true }),
    e({ host_alias: "api-prod-02", hostname: "10.0.4.22", user: "deploy", identity_file: "~/.ssh/id_ed25519" }),
    e({ host_alias: "grafana", hostname: "grafana.internal.acme.dev", user: "ops", port: 2222 }),
    e({ host_alias: "db-replica", hostname: "10.0.6.8", user: "postgres", proxy_jump: "bastion" }),
    e({ host_alias: "gitlab-runner", hostname: "runner-3.ci.acme.dev", user: "gitlab-runner", identity_file: "~/.ssh/ci_runner_rsa" }),
    e({ host_alias: "*.acme.dev", user: "deploy", is_pattern: true }),
  ],
});

export const ScannedConfig = () => (
  <div style={{ width: 960, height: 680 }}>
    <ImportSshConfigModal onClose={noop} onImported={noop} />
  </div>
);
