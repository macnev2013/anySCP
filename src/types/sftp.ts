export interface SftpEntry {
  name: string;
  path: string;
  entry_type: "File" | "Directory" | "Symlink" | "Other";
  size: number;
  permissions: number;
  permissions_display: string;
  modified: number | null;
  is_symlink: boolean;
}

// ─── Clipboard ────────────────────────────────────────────────────────────────

export interface SftpClipboard {
  entries: SftpEntry[];
  operation: "copy" | "cut";
  sourceSessionId: string;
}

// ─── New transfer types ────────────────────────────────────────────────────────

export interface TransferEvent {
  transfer_id: string;
  /** Present for SFTP transfers */
  sftp_session_id?: string;
  /** Present for S3 transfers */
  s3_session_id?: string;
  name: string;
  direction: "Upload" | "Download";
  status: TransferStatusValue;
  error: string | null;
  bytes_transferred: number;
  total_bytes: number;
  files_done: number;
  files_total: number;
  speed_bps: number;
  eta_secs: number | null;
  created_at: number;
}

export type TransferStatusValue =
  | "Queued"
  | "InProgress"
  | "Completed"
  | { Failed: string }
  | "Cancelled";

// ─── Deprecated ───────────────────────────────────────────────────────────────

/**
 * @deprecated Use TransferEvent instead. Kept for backward compatibility.
 */
export interface TransferProgress {
  transfer_id: string;
  sftp_session_id: string;
  file_name: string;
  direction: "Download" | "Upload";
  bytes_transferred: number;
  total_bytes: number;
  status: TransferStatus;
}

/**
 * @deprecated Use TransferStatusValue instead. Kept for backward compatibility.
 */
export type TransferStatus =
  | "InProgress"
  | "Completed"
  | { Failed: string }
  | "Cancelled";
