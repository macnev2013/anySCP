import { S3Card } from "anyscp";
import type { S3Connection } from "../../src/types";
import { noop } from "./_fixtures";

const ts = "2026-08-12T09:30:00Z";
const conn = (p: Partial<S3Connection> & Pick<S3Connection, "id" | "label" | "provider" | "region">): S3Connection => ({
  endpoint: null, bucket: null, path_style: false, group_id: null, color: null, environment: null, notes: null, created_at: ts, ...p,
});

const CONNS: S3Connection[] = [
  conn({ id: "s3-media", label: "media-assets", provider: "aws", region: "us-east-1", bucket: "acme-media-prod", environment: "production" }),
  conn({ id: "s3-backups", label: "db-backups", provider: "r2", region: "auto", bucket: "pg-nightly", environment: "staging", color: "#f59e0b" }),
  conn({ id: "s3-minio", label: "local-minio", provider: "minio", region: "us-east-1", endpoint: "http://localhost:9000", path_style: true, environment: "dev" }),
  conn({ id: "s3-wasabi", label: "archive-cold", provider: "wasabi", region: "eu-central-2" }),
];

const handlers = { onConnect: noop, onEdit: noop, onDuplicate: noop, onDelete: noop };
const Frame = ({ children }: { children: React.ReactNode }) => <div style={{ width: 260 }}>{children}</div>;

export const AwsProduction = () => <Frame><S3Card conn={CONNS[0]} {...handlers} /></Frame>;
export const CustomColor = () => <Frame><S3Card conn={CONNS[1]} {...handlers} /></Frame>;
export const NoBucketNoEnv = () => <Frame><S3Card conn={CONNS[3]} {...handlers} /></Frame>;
export const Grid = () => (
  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 240px)", gap: 12 }}>
    {CONNS.map((c) => <S3Card key={c.id} conn={c} {...handlers} />)}
  </div>
);
