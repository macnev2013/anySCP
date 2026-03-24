export interface S3Entry {
  name: string;
  key: string;
  entry_type: "File" | "Directory";
  size: number;
  last_modified: string | null;
  storage_class: string | null;
}

export interface S3BucketInfo {
  name: string;
  creation_date: string | null;
}

export interface S3ListResult {
  entries: S3Entry[];
  continuation_token: string | null;
  is_truncated: boolean;
  prefix: string;
}

export interface S3Connection {
  id: string;
  label: string;
  provider: string;
  region: string;
  endpoint: string | null;
  bucket: string | null;
  path_style: boolean;
  group_id: string | null;
  color: string | null;
  environment: string | null;
  notes: string | null;
  created_at: string;
}

export type S3Provider = "aws" | "minio" | "localstack" | "r2" | "b2" | "wasabi" | "spaces" | "custom";

export interface S3ProviderPreset {
  id: S3Provider;
  label: string;
  endpointPattern: string;
  regionPlaceholder: string;
  pathStyle: boolean;
}

export const S3_PROVIDERS: S3ProviderPreset[] = [
  { id: "aws", label: "Amazon S3", endpointPattern: "", regionPlaceholder: "us-east-1", pathStyle: false },
  { id: "minio", label: "MinIO", endpointPattern: "http://localhost:9000", regionPlaceholder: "us-east-1", pathStyle: true },
  { id: "localstack", label: "LocalStack", endpointPattern: "http://localhost:4566", regionPlaceholder: "us-east-1", pathStyle: true },
  { id: "r2", label: "Cloudflare R2", endpointPattern: "https://{account_id}.r2.cloudflarestorage.com", regionPlaceholder: "auto", pathStyle: true },
  { id: "b2", label: "Backblaze B2", endpointPattern: "https://s3.{region}.backblazeb2.com", regionPlaceholder: "us-west-004", pathStyle: false },
  { id: "wasabi", label: "Wasabi", endpointPattern: "https://s3.{region}.wasabisys.com", regionPlaceholder: "us-east-1", pathStyle: false },
  { id: "spaces", label: "DigitalOcean Spaces", endpointPattern: "https://{region}.digitaloceanspaces.com", regionPlaceholder: "nyc3", pathStyle: false },
  { id: "custom", label: "Custom S3-Compatible", endpointPattern: "", regionPlaceholder: "us-east-1", pathStyle: false },
];
