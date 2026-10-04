import { HostCard, useHealthStore, useHostsStore } from "anyscp";
import { HOSTS, noop } from "./_fixtures";

useHostsStore.setState({ hosts: HOSTS });
useHealthStore.setState({
  byHostId: {
    "h-api": { status: "reachable", message: null, latencyMs: 23 },
    "h-web": { status: "checking", message: null, latencyMs: null },
    "h-mac": { status: "portClosed", message: "Connection refused on port 22", latencyMs: null },
  },
});

const handlers = { onConnect: noop, onExplore: noop, onEdit: noop, onDelete: noop, onDuplicate: noop };
const byId = (id: string) => HOSTS.find((h) => h.id === id)!;

const Frame = ({ children }: { children: React.ReactNode }) => <div style={{ width: 280 }}>{children}</div>;

export const Production = () => <Frame><HostCard host={byId("h-api")} {...handlers} /></Frame>;
export const Pinging = () => <Frame><HostCard host={byId("h-web")} {...handlers} /></Frame>;
export const ViaJumpHost = () => <Frame><HostCard host={byId("h-db")} {...handlers} /></Frame>;
export const Unreachable = () => <Frame><HostCard host={byId("h-mac")} {...handlers} /></Frame>;
export const Grid = () => (
  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 240px)", gap: 12 }}>
    {HOSTS.map((h) => <HostCard key={h.id} host={h} {...handlers} />)}
  </div>
);
