import { ConnectionDialog } from "anyscp";
import { noop } from "./_fixtures";

// Overlays are position:fixed; the single-card root is their containing block,
// so give them a full-size dark app page to sit on.
const Stage = ({ children }: { children: React.ReactNode }) => (
  <div className="bg-bg-base font-sans" style={{ width: 912, height: 632, position: "relative" }}>{children}</div>
);


export const Connecting = () => <Stage><ConnectionDialog label="deploy@api-prod-01" error={null} onClose={noop} onCancel={noop} /></Stage>;
export const AuthFailed = () => (
  <Stage>
  <ConnectionDialog
    label="postgres@db-replica"
    error="Authentication failed: the server rejected key ~/.ssh/id_ed25519 (publickey). Check that the public key is in ~/.ssh/authorized_keys on 10.0.6.8."
    onClose={noop}
    onRetry={noop}
  />
  </Stage>
);
export const Timeout = () => (
  <Stage>
  <ConnectionDialog label="ci@build-mac" error="Connection timed out after 10s connecting to mac-mini.local:22" onClose={noop} onRetry={noop} />
  </Stage>
);
