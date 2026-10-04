import { ConfirmDangerDialog } from "anyscp";
import { noop } from "./_fixtures";

export const DeleteHost = () => (
  <div className="bg-bg-base" style={{ width: 960, height: 680 }}>
    <ConfirmDangerDialog
      open
      title="Delete api-prod-01?"
      message="The saved host, its stored credentials and its connection history will be permanently removed."
      confirmLabel="Delete host"
      onConfirm={noop}
      onCancel={noop}
    />
  </div>
);
