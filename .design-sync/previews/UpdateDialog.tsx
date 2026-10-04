import { UpdateDialog, useUpdaterStore } from "anyscp";

useUpdaterStore.setState({
  status: "available",
  version: "0.9.0",
  appVersion: "0.8.3",
  dialogOpen: true,
});

export const UpdateAvailable = () => (
  <div className="bg-bg-base" style={{ width: 960, height: 680 }}>
    <UpdateDialog />
  </div>
);
