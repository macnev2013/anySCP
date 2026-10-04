import { QuickConnectInline } from "anyscp";
import { Surface } from "./_fixtures";

// QuickConnectInline is a deprecated no-op (renders null); quick connect moved
// into the HostsDashboard search bar. This cell documents that.
export const Deprecated = () => (
  <Surface width={360}>
    <QuickConnectInline />
    <p className="text-[length:var(--text-xs)] text-text-muted">
      QuickConnectInline renders nothing — quick connect moved to the <span className="font-mono text-text-secondary">HostsDashboard</span> search bar.
    </p>
  </Surface>
);
