import { CardActionButton, CardActionStrip } from "anyscp";
import { Activity, FolderOpen, TerminalSquare } from "lucide-react";
import { Surface, noop } from "./_fixtures";

// The strip pins itself to the top-right of a positioned card.
const Card = ({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) => (
  <div className="relative flex flex-col gap-2.5 p-3.5 bg-bg-surface border border-border rounded-xl" style={{ width: 260 }}>
    {children}
    <div className="w-9 h-9 rounded-full bg-accent-muted" />
    <div>
      <p className="text-[length:var(--text-sm)] font-medium text-text-primary">{title}</p>
      <p className="text-[length:var(--text-xs)] text-text-muted font-mono mt-0.5">{sub}</p>
    </div>
  </div>
);

export const HostActions = () => (
  <Surface>
    <Card title="api-prod-01" sub="deploy@10.0.4.21">
      <CardActionStrip>
        <CardActionButton icon={Activity} label="Ping" ariaLabel="Ping api-prod-01" colorClass="text-status-connected" onClick={noop} />
        <CardActionButton icon={TerminalSquare} label="Terminal" ariaLabel="Open terminal" onClick={noop} />
        <CardActionButton icon={FolderOpen} label="Explorer" ariaLabel="Open explorer" onClick={noop} />
      </CardActionStrip>
    </Card>
  </Surface>
);

export const SingleAction = () => (
  <Surface>
    <Card title="media-assets" sub="aws · us-east-1 · acme-media">
      <CardActionStrip>
        <CardActionButton icon={FolderOpen} label="Explore" ariaLabel="Open explorer for media-assets" onClick={noop} />
      </CardActionStrip>
    </Card>
  </Surface>
);
