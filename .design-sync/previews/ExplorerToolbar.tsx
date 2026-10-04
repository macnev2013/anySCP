import { ExplorerToolbar } from "anyscp";
import type { FileSystemProvider, ProviderCapabilities } from "../../src/types/explorer";
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

function segs(path: string) {
  const parts = path.split("/").filter(Boolean);
  return [{ label: "/", path: "/" }, ...parts.map((p, i) => ({ label: p, path: "/" + parts.slice(0, i + 1).join("/") }))];
}

const base = { onRefresh: noop, onNewFolder: noop, onNewFile: noop, onNavigate: noop, onUpload: noop, onUploadFolder: noop };
const Frame = ({ children }: { children: React.ReactNode }) => (
  <div className="bg-bg-base font-sans" style={{ width: 820 }}>{children}</div>
);

export const SftpNginxLogs = () => (
  <Frame><ExplorerToolbar provider={sftp} currentPath="/var/log/nginx" segments={segs("/var/log/nginx")} loading={false} onToggleSudo={noop} {...base} /></Frame>
);
export const SudoModeOn = () => (
  <Frame><ExplorerToolbar provider={sftp} currentPath="/etc/nginx/sites-available" segments={segs("/etc/nginx/sites-available")} loading={false} sudoMode onToggleSudo={noop} {...base} /></Frame>
);
export const Refreshing = () => (
  <Frame><ExplorerToolbar provider={sftp} currentPath="/home/deploy/releases" segments={segs("/home/deploy/releases")} loading busy onToggleSudo={noop} sudoBusy {...base} /></Frame>
);
export const S3Bucket = () => (
  <Frame>
    <ExplorerToolbar
      provider={s3}
      currentPath="static/img/"
      segments={[{ label: "acme-static-assets", path: "" }, { label: "static", path: "static/" }, { label: "img", path: "static/img/" }]}
      loading={false}
      {...base}
      onUploadFolder={undefined}
    />
  </Frame>
);
