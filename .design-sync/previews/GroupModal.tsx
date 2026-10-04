import { GroupModal } from "anyscp";
import { noop } from "./_fixtures";

// Overlays are position:fixed; the single-card root is their containing block,
// so give them a full-size dark app page to sit on.
const Stage = ({ children }: { children: React.ReactNode }) => (
  <div className="bg-bg-base font-sans" style={{ width: 912, height: 632, position: "relative" }}>{children}</div>
);


const save = async () => {};

export const NewGroup = () => <Stage><GroupModal open onClose={noop} onSave={save} /></Stage>;
export const EditGroup = () => (
  <Stage>
  <GroupModal open onClose={noop} onSave={save} initial={{ name: "Production", color: "#ef4444", icon: "Server" }} />
  </Stage>
);
