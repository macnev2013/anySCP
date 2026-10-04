import { S3Browser, useS3Store, mockTauri } from "anyscp";
import type { S3Entry, S3BucketInfo } from "../../src/types";

// S3Browser reloads on mount (s3_list_buckets / s3_list_objects), so the
// fixtures are served through the Tauri mock rather than only seeded.
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const dir = (name: string): S3Entry => ({ name, key: `${name}/`, entry_type: "Directory", size: 0, last_modified: null, storage_class: null });
const file = (name: string, size: number, days: number, storage_class = "STANDARD"): S3Entry =>
  ({ name, key: name, entry_type: "File", size, last_modified: ago(days), storage_class });

const OBJECTS: S3Entry[] = [
  dir("assets"),
  dir("builds"),
  dir("releases"),
  file("index.html", 4_812, 1),
  file("manifest.json", 1_204, 1),
  file("robots.txt", 68, 120),
  file("favicon.ico", 15_086, 340),
  file("app-v2.14.0.tar.gz", 48_211_904, 3),
  file("db-snapshot-2026-09-30.sql.gz", 1_284_550_656, 4, "STANDARD_IA"),
  file("audit-2025-q4.parquet", 312_440_112, 280, "GLACIER"),
];
const BUCKETS: S3BucketInfo[] = [
  { name: "acme-prod-assets", creation_date: ago(900) },
  { name: "acme-prod-backups", creation_date: ago(870) },
  { name: "acme-staging-uploads", creation_date: ago(400) },
  { name: "acme-terraform-state", creation_date: ago(1100) },
  { name: "acme-logs-archive", creation_date: ago(620) },
];

mockTauri({
  s3_list_buckets: () => BUCKETS,
  s3_list_objects: (args: Record<string, unknown>) => {
    if (args.s3SessionId === "s3-denied") throw { message: "AccessDenied: s3:ListBucket on arn:aws:s3:::acme-finance-exports" };
    return { entries: OBJECTS, continuation_token: null, is_truncated: false, prefix: "" };
  },
});

const session = (sessionId: string, label: string, currentBucket: string | null) => ({
  sessionId, label, currentBucket, currentPrefix: "", entries: [], buckets: [],
  loading: false, error: null, sortBy: "name" as const, sortAsc: true,
});
useS3Store.setState({
  sessions: new Map([
    ["s3-prod", session("s3-prod", "AWS Production", "acme-prod-assets")],
    ["s3-pick", session("s3-pick", "AWS Production", null)],
    ["s3-denied", session("s3-denied", "Finance (read-only)", "acme-finance-exports")],
  ]),
  activeS3SessionId: "s3-prod",
});

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div className="bg-bg-base text-text-primary font-sans" style={{ width: 1232, height: 752 }}>{children}</div>
);

export const BucketObjects = () => <Frame><S3Browser sessionId="s3-prod" /></Frame>;
export const BucketPicker = () => <Frame><S3Browser sessionId="s3-pick" isActive={false} /></Frame>;
export const AccessDenied = () => <Frame><S3Browser sessionId="s3-denied" isActive={false} /></Frame>;
