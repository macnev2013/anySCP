import { CardActionButton, CardActionStrip } from "anyscp";
import { Activity, FolderOpen, TerminalSquare, Pencil } from "lucide-react";
import { Surface, noop } from "./_fixtures";

// A card-corner icon button. Rendered inside a card-shaped box so the absolute
// tooltip pill has room and the button sits on its real surface.
// `showTip` pins the hover-only tooltip pill open so its look is visible.
const CardBox = ({ children, showTip = false }: { children: React.ReactNode; showTip?: boolean }) => (
  <div className={"relative bg-bg-surface border border-border rounded-xl" + (showTip ? " ds-show-tip" : "")} style={{ width: 240, height: 84 }}>
    {showTip && <style>{".ds-show-tip button > span { opacity: 1 !important; }"}</style>}
    <div style={{ position: "absolute", top: 8, right: 8 }}>{children}</div>
    <p className="text-[length:var(--text-sm)] font-medium text-text-primary" style={{ position: "absolute", left: 14, top: 14, margin: 0 }}>api-prod-01</p>
  </div>
);

export const Default = () => (
  <Surface>
    <CardBox showTip>
      <CardActionButton icon={TerminalSquare} label="Terminal" ariaLabel="Open terminal on api-prod-01" onClick={noop} />
    </CardBox>
  </Surface>
);

export const PingReachable = () => (
  <Surface>
    <CardBox showTip>
      <CardActionButton
        icon={Activity}
        label="Ping"
        detail="Reachable · 23 ms"
        ariaLabel="Ping api-prod-01"
        colorClass="text-status-connected"
        onClick={noop}
      />
    </CardBox>
  </Surface>
);

export const PingInFlight = () => (
  <Surface>
    <CardBox showTip>
      <CardActionButton icon={Activity} label="Ping" detail="Checking…" ariaLabel="Ping web-staging" busy colorClass="text-status-connecting" onClick={noop} />
    </CardBox>
  </Surface>
);

export const Disabled = () => (
  <Surface>
    <CardBox>
      <CardActionButton icon={Pencil} label="Edit" ariaLabel="Edit host" disabled colorClass="text-text-muted opacity-40" onClick={noop} />
    </CardBox>
  </Surface>
);

export const ActionRow = () => (
  <Surface>
    <div className="relative bg-bg-surface border border-border rounded-xl" style={{ width: 240, height: 72 }}>
      <CardActionStrip>
        <CardActionButton icon={Activity} label="Ping" ariaLabel="Ping" colorClass="text-status-connected" onClick={noop} />
        <CardActionButton icon={TerminalSquare} label="Terminal" ariaLabel="Terminal" onClick={noop} />
        <CardActionButton icon={FolderOpen} label="Explorer" ariaLabel="Explorer" onClick={noop} />
      </CardActionStrip>
      <p className="text-[length:var(--text-sm)] font-medium text-text-primary" style={{ position: "absolute", left: 14, top: 14, margin: 0 }}>api-prod-01</p>
    </div>
  </Surface>
);
