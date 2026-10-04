import { ModalShell, BTN_GHOST, BTN_PRIMARY, BTN_SECONDARY, BTN_DANGER } from "anyscp";
import { Server, Code2, Trash2, FolderTree } from "lucide-react";
import { noop } from "./_fixtures";

// ModalShell is `fixed inset-0`; a transformed wrapper becomes the containing
// block so each cell holds its own backdrop + panel instead of covering the page.
const Stage = ({ children, h = 440 }: { children: React.ReactNode; h?: number }) => (
  <div className="bg-bg-base font-sans" style={{ width: 760, height: h, transform: "translateZ(0)", overflow: "hidden", borderRadius: 8 }}>
    {children}
  </div>
);

const Field = ({ label, value, mono }: { label: string; value: string; mono?: boolean }) => (
  <div className="flex flex-col gap-1">
    <span className="text-[length:var(--text-xs)] font-medium text-text-secondary">{label}</span>
    <div className={`w-full px-3 py-2 rounded-lg text-[length:var(--text-sm)] bg-bg-base border border-border text-text-primary ${mono ? "font-mono" : ""}`}>{value}</div>
  </div>
);

export const WithIconAndFooter = () => (
  <Stage h={480}>
    <ModalShell
      open
      onClose={noop}
      title="Edit host"
      icon={Server}
      footer={<><button className={BTN_GHOST}>Cancel</button><button className={BTN_PRIMARY}>Save</button></>}
    >
      <div className="flex flex-col gap-3">
        <Field label="Label" value="api-prod-01" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 96px", gap: 12 }}>
          <Field label="Host" value="10.0.4.21" mono />
          <Field label="Port" value="22" mono />
        </div>
        <Field label="Username" value="deploy" />
      </div>
    </ModalShell>
  </Stage>
);

export const WithSubtitleAndFooterStart = () => (
  <Stage>
    <ModalShell
      open
      onClose={noop}
      title="Tail nginx error log"
      subtitle="sudo tail -n 200 -f /var/log/nginx/error.log"
      icon={Code2}
      maxWidth="md"
      footerStart={<button className={`${BTN_GHOST} !text-status-error`}><Trash2 size={13} className="inline mr-1.5 -mt-0.5" />Delete</button>}
      footer={<><button className={BTN_SECONDARY}>Cancel</button><button className={BTN_PRIMARY}>Run snippet</button></>}
    >
      <p className="text-[length:var(--text-sm)] text-text-secondary">
        Streams the last 200 lines of the nginx error log and follows new entries. Runs in the active terminal on <span className="text-text-primary font-medium">web-staging</span>.
      </p>
    </ModalShell>
  </Stage>
);

export const DangerSmall = () => (
  <Stage h={340}>
    <ModalShell
      open
      onClose={noop}
      title="Delete group “Production”?"
      icon={FolderTree}
      iconVariant="danger"
      maxWidth="sm"
      footer={<><button className={BTN_GHOST}>Cancel</button><button className={BTN_DANGER}>Delete group</button></>}
    >
      <p className="text-[length:var(--text-sm)] text-text-secondary">
        The 2 hosts in this group will move to Ungrouped. This can’t be undone.
      </p>
    </ModalShell>
  </Stage>
);

export const ScrollableBody = () => (
  <Stage h={680}>
    <ModalShell
      open
      onClose={noop}
      title="Import from ~/.ssh/config"
      icon={Server}
      scrollable
      maxWidth="xl"
      footer={<><button className={BTN_GHOST}>Cancel</button><button className={BTN_PRIMARY}>Import 14 hosts</button></>}
    >
      <ul className="flex flex-col">
        {["api-prod-01 · deploy@10.0.4.21", "api-prod-02 · deploy@10.0.4.22", "web-staging · ubuntu@staging.acme.dev", "bastion · ops@bastion.acme.dev", "db-replica · postgres@10.0.6.8", "homelab-pi · pi@192.168.1.40", "build-mac · ci@mac-mini.local", "grafana · admin@metrics.acme.dev", "jenkins · jenkins@ci.acme.dev", "vault · vault@vault.acme.dev", "redis-cache · redis@10.0.7.3", "k8s-node-1 · core@10.0.8.11", "k8s-node-2 · core@10.0.8.12", "minio · minio@s3.acme.dev"].map((r) => (
          <li key={r} className="py-2.5 border-b border-border last:border-b-0 text-[length:var(--text-sm)] text-text-primary font-mono">{r}</li>
        ))}
      </ul>
    </ModalShell>
  </Stage>
);
