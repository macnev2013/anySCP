import { GroupDeleteDialog } from "anyscp";
import type { HostGroup } from "../../src/types";
import { noop } from "./_fixtures";

// Overlays are position:fixed; the single-card root is their containing block,
// so give them a full-size dark app page to sit on.
const Stage = ({ children }: { children: React.ReactNode }) => (
  <div className="bg-bg-base font-sans" style={{ width: 912, height: 632, position: "relative" }}>{children}</div>
);


const ts = "2026-06-01T08:00:00Z";
const grp = (name: string): HostGroup => ({ id: "g-" + name, name, color: "#ef4444", icon: "Server", sort_order: 0, default_username: null, created_at: ts, updated_at: ts });

export const WithHosts = () => <Stage><GroupDeleteDialog group={grp("Production")} hostCount={12} onConfirm={noop} onCancel={noop} /></Stage>;
export const EmptyGroup = () => <Stage><GroupDeleteDialog group={grp("Legacy VPS")} hostCount={0} onConfirm={noop} onCancel={noop} /></Stage>;
