import { S3Page, useS3Store, mockTauri } from "anyscp";
import type { S3Connection } from "../../src/types";

// Landing view: no active browser session, two open sessions + saved connections.
const conn = (p: Partial<S3Connection> & Pick<S3Connection, "id" | "label" | "provider" | "region">): S3Connection => ({
  endpoint: null, bucket: null, path_style: false, group_id: null, color: null, environment: null, notes: null,
  created_at: "2026-02-01T10:00:00Z", ...p,
});
const CONNECTIONS: S3Connection[] = [
  conn({ id: "c-aws-prod", label: "AWS Production", provider: "aws", region: "us-east-1", bucket: "acme-prod-assets", environment: "production", color: "#f59e0b" }),
  conn({ id: "c-r2", label: "Cloudflare R2", provider: "r2", region: "auto", bucket: "cdn-media", color: "#f97316" }),
  conn({ id: "c-minio", label: "Corp MinIO", provider: "minio", region: "eu-west-1", endpoint: "https://minio.acme.internal:9443", bucket: "backups", path_style: true, environment: "staging" }),
  conn({ id: "c-b2", label: "Backblaze Archive", provider: "b2", region: "us-west-004", bucket: "cold-archive" }),
  conn({ id: "c-spaces", label: "DO Spaces", provider: "spaces", region: "nyc3", environment: "dev", color: "#3b82f6" }),
];
mockTauri({ s3_list_connections: CONNECTIONS });

const session = (sessionId: string, label: string, currentBucket: string | null) => ({
  sessionId, label, currentBucket, currentPrefix: "", entries: [], buckets: [],
  loading: false, error: null, sortBy: "name" as const, sortAsc: true,
});
useS3Store.setState({
  sessions: new Map([
    ["c-aws-prod", session("c-aws-prod", "AWS Production", "acme-prod-assets")],
    ["c-r2", session("c-r2", "Cloudflare R2", "cdn-media")],
  ]),
  activeS3SessionId: null,
});

export const Connections = () => (
  <div style={{ width: 1232, height: 752 }}>
    <S3Page />
  </div>
);
