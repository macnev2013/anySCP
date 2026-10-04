import { GroupCard } from "anyscp";
import type { HostGroup } from "../../src/types";
import { Surface, noop } from "./_fixtures";

const ts = "2026-06-01T08:00:00Z";
const g = (id: string, name: string, color: string, icon: string | null, sort_order: number): HostGroup => ({
  id, name, color, icon, sort_order, default_username: null, created_at: ts, updated_at: ts,
});
const GROUPS = [
  g("g-prod", "Production", "#ef4444", "Server", 0),
  g("g-stage", "Staging", "#f59e0b", "Rocket", 1),
  g("g-db", "Databases", "#3b82f6", "Database", 2),
  g("g-home", "Home Lab", "#22c55e", "Home", 3),
];
const counts: Record<string, number> = { "g-prod": 12, "g-stage": 4, "g-db": 1, "g-home": 0 };

const one = (i: number, selected = false) => (
  <Surface>
    <div style={{ width: 180 }}>
      <GroupCard group={GROUPS[i]} hostCount={counts[GROUPS[i].id]} isSelected={selected} onSelect={noop} onDelete={noop} />
    </div>
  </Surface>
);

export const Default = () => one(0);
export const Selected = () => one(1, true);
export const SingleHost = () => one(2);
export const Row = () => (
  <Surface>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 160px)", gap: 12 }}>
      {GROUPS.map((gr, i) => (
        <GroupCard key={gr.id} group={gr} hostCount={counts[gr.id]} isSelected={i === 0} onSelect={noop} onDelete={noop} />
      ))}
    </div>
  </Surface>
);
