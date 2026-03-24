// ─── Unified explorer types ──────────────────────────────────────────────────

/** Normalized file entry that both SFTP and S3 entries convert into. */
export interface ExplorerEntry {
  /** Display name */
  name: string;
  /** Unique identifier (SFTP: absolute path, S3: object key) */
  id: string;
  entryType: "File" | "Directory";
  size: number;
  /** Unix timestamp in seconds */
  modified: number | null;
  /** SFTP-only: e.g. "drwxr-xr-x" */
  permissionsDisplay: string | null;
  /** SFTP-only */
  isSymlink: boolean;
  /** S3-only: e.g. "STANDARD", "GLACIER" */
  storageClass: string | null;
}

/** Clipboard for copy/cut/paste within a session. */
export interface ExplorerClipboard {
  entries: ExplorerEntry[];
  operation: "copy" | "cut";
  sourceSessionId: string;
}

/** Controls which UI elements and actions are available. */
export interface ProviderCapabilities {
  canRename: boolean;
  canCreateFile: boolean;
  canCreateFolder: boolean;
  canDelete: boolean;
  canUpload: boolean;
  canDownload: boolean;
  canDragDropUpload: boolean;
  canInternalDragMove: boolean;
  canCopyPaste: boolean;
  canEditInEditor: boolean;
  canGetInfo: boolean;
  hasPermissions: boolean;
  hasStorageClass: boolean;
  canPresignUrl: boolean;
}

/**
 * Operations adapter — bridges shared UI components to SFTP/S3 backend calls.
 * Each browser (SftpBrowser, S3Browser) creates a provider and passes it to
 * the shared ExplorerFileTable and ExplorerToolbar.
 */
export interface FileSystemProvider {
  readonly type: "sftp" | "s3";
  readonly sessionId: string;
  readonly capabilities: ProviderCapabilities;

  /** Join a parent path with a child name. */
  joinPath(parent: string, child: string): string;
  /** Get the parent of a path. */
  parentPath(path: string): string;
  /** Display label for the root (SFTP: "/", S3: bucket name). */
  rootLabel(): string;
}
