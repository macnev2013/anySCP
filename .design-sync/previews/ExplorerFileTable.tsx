import { ExplorerFileTable } from "anyscp";
import type { ExplorerEntry, ExplorerClipboard, FileSystemProvider, ProviderCapabilities } from "../../src/types/explorer";
import { noop } from "./_fixtures";

const SFTP_CAPS: ProviderCapabilities = {
  canRename: true, canCreateFile: true, canCreateFolder: true, canDelete: true, canUpload: true,
  canDownload: true, canDragDropUpload: true, canInternalDragMove: true, canCopyPaste: true,
  canEditInEditor: true, canGetInfo: true, hasPermissions: true, hasStorageClass: false, canPresignUrl: false,
};
const sftp: FileSystemProvider = {
  type: "sftp", sessionId: "sftp-api", capabilities: SFTP_CAPS,
  joinPath: (p, c) => (p.endsWith("/") ? `${p}${c}` : `${p}/${c}`),
  parentPath: (p) => { const i = p.lastIndexOf("/"); return i <= 0 ? "/" : p.slice(0, i); },
  rootLabel: () => "/",
};
const s3: FileSystemProvider = {
  type: "s3", sessionId: "s3-assets",
  capabilities: { ...SFTP_CAPS, hasPermissions: false, hasStorageClass: true, canPresignUrl: true, canInternalDragMove: false },
  joinPath: (p, c) => `${p}${c}`,
  parentPath: (p) => p.replace(/[^/]+\/$/, ""),
  rootLabel: () => "acme-static-assets",
};

const now = Math.floor(Date.now() / 1000);
const H = 3600, D = 86400;
const f = (dir: string, name: string, size: number, age: number, perms = "-rw-r--r--", extra: Partial<ExplorerEntry> = {}): ExplorerEntry => ({
  name, id: `${dir}/${name}`, entryType: "File", size, modified: now - age, permissionsDisplay: perms,
  permissions: null, isSymlink: false, storageClass: null, ...extra,
});
const d = (dir: string, name: string, age: number, perms = "drwxr-xr-x"): ExplorerEntry => ({
  ...f(dir, name, 4096, age, perms), entryType: "Directory",
});

const LOG = "/var/log/nginx";
const NGINX: ExplorerEntry[] = [
  d(LOG, "archive", 3 * D),
  d(LOG, "vhosts", 12 * D),
  f(LOG, "access.log", 48_213_904, 2 * 60),
  f(LOG, "access.log.1", 112_448_210, 1 * D),
  f(LOG, "access.log.2.gz", 9_812_331, 2 * D),
  f(LOG, "error.log", 1_342_118, 14 * 60, "-rw-r-----"),
  f(LOG, "error.log.1", 884_120, 1 * D, "-rw-r-----"),
  f(LOG, "error.log.2.gz", 102_554, 2 * D, "-rw-r-----"),
  f(LOG, "current", 0, 6 * H, "lrwxrwxrwx", { isSymlink: true }),
  f(LOG, "healthcheck.log", 22_310, 30, "-rw-r--r--"),
];

const S3: ExplorerEntry[] = [
  { ...d("static", "fonts", 40 * D), id: "static/fonts/", permissionsDisplay: null, modified: null },
  { ...d("static", "img", 40 * D), id: "static/img/", permissionsDisplay: null, modified: null },
  { ...f("static", "app.4f2c9e.js", 812_330, 3 * H), id: "static/app.4f2c9e.js", permissionsDisplay: null, storageClass: "STANDARD" },
  { ...f("static", "app.4f2c9e.css", 96_114, 3 * H), id: "static/app.4f2c9e.css", permissionsDisplay: null, storageClass: "STANDARD" },
  { ...f("static", "release-2025-q4.tar.gz", 1_204_882_112, 280 * D), id: "static/release-2025-q4.tar.gz", permissionsDisplay: null, storageClass: "GLACIER" },
  { ...f("static", "sitemap.xml", 18_442, 1 * D), id: "static/sitemap.xml", permissionsDisplay: null, storageClass: "STANDARD_IA" },
];

const cut: ExplorerClipboard = { entries: [NGINX[4], NGINX[7]], operation: "cut", sourceSessionId: "sftp-api" };

const handlers = {
  onSortChange: noop, onSetClipboard: noop, onNavigate: noop, onDownload: noop, onDownloadMany: noop,
  onDelete: async () => {}, onRename: async () => {}, onEditInEditor: noop, onApplyPermissions: async () => {},
  onCreateFile: noop, onCancelCreateFile: noop, onCreateFolder: noop, onCancelCreateFolder: noop, onPaste: noop,
  onMoveEntries: async () => {}, onCopyEntries: async () => {},
};

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div className="flex flex-col bg-bg-base text-text-primary font-sans border border-border rounded-lg overflow-hidden" style={{ width: 860, height: 420 }}>
    {children}
  </div>
);

export const SftpListing = () => (
  <Frame><ExplorerFileTable provider={sftp} entries={NGINX} sortBy="name" sortAsc clipboard={null} currentPath={LOG} {...handlers} /></Frame>
);
export const SortedBySizeWithCut = () => (
  <Frame><ExplorerFileTable provider={sftp} entries={NGINX} sortBy="size" sortAsc={false} clipboard={cut} currentPath={LOG} {...handlers} /></Frame>
);
export const S3Objects = () => (
  <Frame><ExplorerFileTable provider={s3} entries={S3} sortBy="modified" sortAsc={false} clipboard={null} currentPath="static/" {...handlers} onApplyPermissions={undefined} /></Frame>
);
export const NewFolderRow = () => (
  <Frame><ExplorerFileTable provider={sftp} entries={NGINX.slice(0, 5)} sortBy="name" sortAsc clipboard={null} creatingFolder currentPath={LOG} {...handlers} /></Frame>
);
export const EmptyFolder = () => (
  <Frame><ExplorerFileTable provider={sftp} entries={[]} sortBy="name" sortAsc clipboard={null} currentPath="/srv/uploads/tmp" {...handlers} /></Frame>
);
export const Loading = () => (
  <Frame><ExplorerFileTable provider={sftp} entries={[]} sortBy="name" sortAsc clipboard={null} loading currentPath="/opt/backups" {...handlers} /></Frame>
);
