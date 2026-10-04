import { QuickConnect } from "anyscp";
import { Surface } from "./_fixtures";

// QuickConnect is a deprecated no-op kept for stale imports (renders null);
// its role moved to HostEditModal. The cell shows that it renders nothing.
export const DeprecatedNoOp = () => (
  <Surface width={420}>
    <QuickConnect />
    <p className="text-[length:var(--text-sm)] text-text-muted">QuickConnect renders nothing — superseded by HostEditModal.</p>
  </Surface>
);
