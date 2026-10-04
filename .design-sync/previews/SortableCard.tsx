import { SortableCard, GroupCard, HostCard, useHostsStore } from "anyscp";
import type { HostGroup } from "../../src/types";
import { HOSTS, Surface, noop } from "./_fixtures";

useHostsStore.setState({ hosts: HOSTS });

const ts = "2026-06-01T08:00:00Z";
const prod: HostGroup = { id: "g-prod", name: "Production", color: "#ef4444", icon: "Server", sort_order: 0, default_username: null, created_at: ts, updated_at: ts };
const hostHandlers = { onConnect: noop, onExplore: noop, onEdit: noop, onDelete: noop, onDuplicate: noop };

// SortableCard is the invisible drag shell around every dashboard card; at rest
// it renders its child unchanged.
export const WrappingHostCard = () => (
  <Surface>
    <div style={{ width: 260 }}>
      <SortableCard id="h-api"><HostCard host={HOSTS[0]} {...hostHandlers} /></SortableCard>
    </div>
  </Surface>
);

export const WrappingGroupCard = () => (
  <Surface>
    <div style={{ width: 180 }}>
      <SortableCard id="g-prod"><GroupCard group={prod} hostCount={12} isSelected={false} onSelect={noop} onDelete={noop} /></SortableCard>
    </div>
  </Surface>
);

export const SortableGrid = () => (
  <Surface>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 230px)", gap: 12 }}>
      {HOSTS.slice(0, 3).map((h) => (
        <SortableCard key={h.id} id={h.id}><HostCard host={h} {...hostHandlers} /></SortableCard>
      ))}
    </div>
  </Surface>
);
