import { SplitHandle } from "anyscp";
import { noop } from "./_fixtures";

// The handle itself is an invisible 8px drag target (col-/row-resize cursor)
// that sits in the gap between two panes — shown here in that context.
const PaneStub = ({ host }: { host: string }) => (
  <div className="flex-1 min-w-0 min-h-0 rounded-lg border border-border/60 bg-bg-base overflow-hidden flex flex-col">
    <div className="h-8 px-2.5 flex items-center gap-2.5 bg-bg-surface/60 border-b border-border/40">
      <span className="w-2 h-2 rounded-full bg-status-connected" />
      <span className="text-[11px] font-mono text-text-muted">{host}</span>
    </div>
  </div>
);

export const BetweenColumns = () => (
  <div className="flex flex-row bg-bg-base p-3 rounded-lg" style={{ width: 560, height: 200 }}>
    <PaneStub host="api-prod-01.acme.dev" />
    <SplitHandle direction="horizontal" onResize={noop} />
    <PaneStub host="logs-01.acme.dev" />
  </div>
);

export const BetweenRows = () => (
  <div className="flex flex-col bg-bg-base p-3 rounded-lg" style={{ width: 560, height: 240 }}>
    <PaneStub host="api-prod-01.acme.dev" />
    <SplitHandle direction="vertical" onResize={noop} />
    <PaneStub host="10.0.6.8" />
  </div>
);
