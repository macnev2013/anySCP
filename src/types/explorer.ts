import type { EditorConfig } from "../stores/settings-store";

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
  /** SFTP-only: raw Unix mode (lower 12 bits incl. setuid/setgid/sticky), or
   *  `null` when the transport has no Unix permissions (e.g. S3). Used to
   *  preserve special bits the rwx display string can't represent. */
  permissions: number | null;
  /** SFTP-only */
  isSymlink: boolean;
  /** S3-only: e.g. "STANDARD", "GLACIER" */
  storageClass: string | null;
}

/** Result of a recursive chmod — mirrors the Rust `ChmodSummary`. */
export interface ChmodResult {
  /** Number of entries whose permissions were successfully updated. */
  applied: number;
  /** Per-entry failure messages collected during the walk (empty = success). */
  errors: string[];
}

/** Outcome of an OS drag-out — mirrors the Rust `DragOutResult`. */
export interface DragOutResult {
  /** True if the native drag ended in a drop (vs. cancelled). */
  dropped: boolean;
  /** Number of top-level items that were dragged. */
  count: number;
}

/** Clipboard for copy/cut/paste within a session. */
export interface ExplorerClipboard {
  entries: ExplorerEntry[];
  operation: "copy" | "cut";
  sourceSessionId: string;
}

/**
 * A handle the dual-pane container uses to drive one pane during a cross-pane
 * transfer. Each `<Explorer>` registers one on mount; the sibling reads the
 * target's cwd and calls its upload/download entry point.
 */
export interface PaneRuntime {
  /** This pane's current directory — the destination when it's a transfer target. */
  getCurrentPath(): string;
  /** Reload this pane's listing. */
  refresh(): void;
  /** Upload local paths into this pane's current dir, through the same
   *  conflict/overwrite guard as the toolbar upload. Present only on panes whose
   *  provider can receive uploads (SFTP/SCP), absent on the local pane.
   *  `onEnqueued` reports the queued transfer ids (used by a move to delete the
   *  source once its transfer completes). */
  uploadInto?(localPaths: string[], onEnqueued?: (transferIds: string[]) => void, targetDir?: string): void;
  /** Download these entries from this pane into a local directory. Present only
   *  on panes whose provider can produce downloads (SFTP/SCP). `onEnqueued`
   *  reports the queued transfer ids. */
  downloadTo?(entries: ExplorerEntry[], localDir: string, onEnqueued?: (transferIds: string[]) => void): void;
  /** Receive a cross-pane download INTO this pane: run the destination-side
   *  overwrite pre-check against this pane's current dir, then invoke `run` with
   *  the resolved local dir to perform the transfer. The mirror of `uploadInto`'s
   *  built-in guard, for the download direction. */
  receiveDownload?(entries: ExplorerEntry[], run: (localDir: string) => void, targetDir?: string): void;
  /** Delete these entries from this pane and refresh. Used to remove the source
   *  after a cross-pane MOVE's transfer completes. */
  remove?(entries: ExplorerEntry[]): void;
  /** Clear this pane's own copy/cut clipboard — used when its cut was consumed by
   *  a cross-pane move, so a later same-pane paste doesn't act on moved sources. */
  clearClipboard?(): void;
}

/**
 * Describes the sibling pane so a pane can offer a "Copy to <sibling>" action.
 * Only wired for the local↔remote SFTP/SCP dual-pane.
 */
export interface CrossPaneTarget {
  /** Label of the other pane (host name or "Local"). */
  siblingLabel: string;
  /** Copy the given entries into the sibling pane. `targetDir` overrides the
   *  destination (a folder/".." the drop landed on); omitted = the sibling's cwd. */
  copyTo(entries: ExplorerEntry[], targetDir?: string): void;
  /** Move the given entries into the sibling pane: transfer across, then delete
   *  each source only after ITS transfer reports Completed (never on a partial
   *  or failed transfer). Triggered by Alt+drag across panes and by a cut+paste
   *  into the sibling. `targetDir` overrides the destination dir (drop-on-folder). */
  moveTo(entries: ExplorerEntry[], targetDir?: string): void;
  /** Sync this pane's clipboard change into the shared cross-pane slot: a COPY
   *  becomes the pane's cross-pane offer; a CUT or clear (null) empties the slot,
   *  since cut is same-pane only (there is no cross-pane move) and must not let a
   *  stale earlier copy hijack a subsequent same-pane paste. */
  syncClipboard(clip: ExplorerClipboard | null): void;
  /** If the shared clipboard's most-recent copy came from the SIBLING pane,
   *  transfer those entries into this pane's current dir and return true.
   *  Returns false when the last copy was in this pane (or none), so the caller
   *  falls through to the ordinary same-pane paste. */
  pasteFromSibling(): boolean;
  /** True when the shared clipboard's most-recent copy came from the SIBLING
   *  pane — i.e. a cross-pane paste here would do something. Used to show the
   *  "Paste" affordance in a pane whose own clipboard is empty. Read at
   *  menu-open time; the shared slot is a ref, not reactive state. */
  hasSiblingClipboard(): boolean;
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
 * Operations adapter — the single seam between the shared explorer UI and a
 * concrete backend (SFTP/SCP, S3, or the local filesystem). One provider-driven
 * container renders every backend; each provider maps the abstract operations
 * below to its own commands (e.g. `delete` → `sftp_delete` / `s3_delete_object`
 * / `local_delete`). Operations that a backend can't do are left unimplemented
 * and gated by the matching capability, so the UI hides them.
 */
export interface FileSystemProvider {
  readonly type: "sftp" | "scp" | "s3" | "local";
  readonly sessionId: string;
  readonly capabilities: ProviderCapabilities;

  // ─── Path helpers (pure, sync) ───────────────────────────────────────────
  /** Join a parent path with a child name. */
  joinPath(parent: string, child: string): string;
  /** Get the parent of a path. */
  parentPath(path: string): string;
  /** Display label for the root (SFTP: "/", S3: bucket name, local: "/" or drive). */
  rootLabel(): string;
  /** Path-bar breadcrumb segments for a path, root-first. */
  breadcrumbs(path: string): { label: string; path: string }[];

  // ─── Operations (async; map to backend commands) ─────────────────────────
  /** List a directory, normalized to `ExplorerEntry` rows. */
  listDir(path: string): Promise<ExplorerEntry[]>;
  /** The starting directory (SFTP/local home; S3 root prefix ""). */
  homeDir(): Promise<string>;
  /** Create a directory at the given full path. */
  mkdir(path: string): Promise<void>;
  /** Create an empty file at the given full path. */
  createFile(path: string): Promise<void>;
  /** Delete an entry (folder or file — the provider handles the distinction). */
  delete(entry: ExplorerEntry): Promise<void>;

  // ─── Optional operations (gated by the matching capability) ──────────────
  /** Rename/move within the same dir. Requires `canRename`. */
  rename?(entry: ExplorerEntry, newPath: string): Promise<void>;
  /** Change permissions. Requires `hasPermissions`; returns a recursive summary. */
  chmod?(entry: ExplorerEntry, mode: number, recursive: boolean): Promise<ChmodResult | undefined>;
  /** Open in an external editor. Requires `canEditInEditor`. */
  editInEditor?(entry: ExplorerEntry, editor: EditorConfig | null): Promise<void>;
  /** Move entries into a target dir (in-backend). Requires `canInternalDragMove`. */
  move?(sourceIds: string[], targetDir: string): Promise<void>;
  /** Copy entries into a target dir (in-backend). Requires `canCopyPaste`. */
  copy?(sourceIds: string[], targetDir: string): Promise<void>;
  /** Presign a shareable URL. Requires `canPresignUrl` (S3). */
  presignUrl?(entry: ExplorerEntry): Promise<string>;
  /** Stage the selection and start a native OS drag-out. SFTP/SCP only. */
  dragOut?(entryIds: string[]): Promise<DragOutResult>;

  // ─── Transfers (the dual-pane coordinator decides direction/refresh; the
  //     provider just knows its own command). Gated by canUpload/canDownload. ─
  /** Download one entry to an exact local path (save-as). */
  downloadAs?(entry: ExplorerEntry, localPath: string): Promise<void>;
  /** Download several entries into a local directory (through the queue). */
  enqueueDownload?(entryIds: string[], localDir: string): Promise<string[]>;
  /** Upload local paths into a target dir on this backend (through the queue).
   *  Resolves with the queued transfer ids (one per top-level path, in order). */
  enqueueUpload?(localPaths: string[], targetDir: string): Promise<string[]>;
}
