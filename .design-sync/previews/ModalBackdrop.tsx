import { ModalBackdrop } from "anyscp";
import { noop } from "./_fixtures";

// The backdrop only owns the overlay + close rule; callers pass positioning/
// dimming classes. A transformed stage contains the `fixed inset-0` overlay.
const Stage = ({ children }: { children: React.ReactNode }) => (
  <div className="bg-bg-base font-sans" style={{ width: 640, height: 360, transform: "translateZ(0)", overflow: "hidden", borderRadius: 8 }}>
    <div className="p-6 flex flex-col gap-2">
      {["api-prod-01", "web-staging", "bastion", "db-replica"].map((h) => (
        <div key={h} className="px-4 py-3 rounded-lg bg-bg-surface border border-border text-[length:var(--text-sm)] text-text-primary">{h}</div>
      ))}
    </div>
    {children}
  </div>
);

const Panel = ({ title, body }: { title: string; body: string }) => (
  <div className="w-full max-w-sm rounded-xl bg-bg-overlay border border-border shadow-[var(--shadow-lg)] px-6 py-5">
    <h2 className="text-[length:var(--text-lg)] font-semibold text-text-primary">{title}</h2>
    <p className="mt-2 text-[length:var(--text-sm)] text-text-secondary">{body}</p>
  </div>
);

export const DimmedBlur = () => (
  <Stage>
    <ModalBackdrop onClose={noop} className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <Panel title="Connecting…" body="Opening SSH session to deploy@10.0.4.21:22" />
    </ModalBackdrop>
  </Stage>
);

export const TopAlignedBusy = () => (
  <Stage>
    <ModalBackdrop onClose={noop} closeDisabled className="fixed inset-0 z-50 flex items-start justify-center pt-10 bg-black/70">
      <Panel title="Restoring backup" body="Backdrop clicks are ignored while the import runs (closeDisabled)." />
    </ModalBackdrop>
  </Stage>
);
