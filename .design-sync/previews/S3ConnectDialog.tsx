import { S3ConnectDialog, useGroupsStore } from "anyscp";
import type { S3Connection } from "../../src/types";
import { noop } from "./_fixtures";

useGroupsStore.setState({ groups: [] });

const SAVED_MINIO: S3Connection = {
  id: "conn-minio",
  label: "Corp MinIO",
  provider: "minio",
  region: "eu-west-1",
  endpoint: "https://minio.acme.internal:9443",
  bucket: "backups",
  path_style: true,
  group_id: null,
  color: "#f97316",
  environment: "staging",
  notes: "Nightly pg_dump + restic snapshots",
  created_at: "2026-01-12T09:30:00Z",
};

// Full-size app backdrop so the modal scrim covers the whole frame.
const Backdrop = ({ children }: { children: React.ReactNode }) => (
  <div className="bg-bg-base" style={{ width: 912, height: 632 }}>{children}</div>
);

export const NewConnection = () => <Backdrop><S3ConnectDialog onClose={noop} /></Backdrop>;
export const EditConnection = () => <Backdrop><S3ConnectDialog onClose={noop} editConnection={SAVED_MINIO} /></Backdrop>;
