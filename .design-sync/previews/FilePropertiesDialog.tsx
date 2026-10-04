import { FilePropertiesDialog } from "anyscp";
import type { ExplorerEntry, ProviderCapabilities } from "../../src/types/explorer";
import { noop } from "./_fixtures";

const SFTP_CAPS: ProviderCapabilities = {
  canRename: true, canCreateFile: true, canCreateFolder: true, canDelete: true, canUpload: true,
  canDownload: true, canDragDropUpload: true, canInternalDragMove: true, canCopyPaste: true,
  canEditInEditor: true, canGetInfo: true, hasPermissions: true, hasStorageClass: false, canPresignUrl: false,
};
const S3_CAPS: ProviderCapabilities = { ...SFTP_CAPS, hasPermissions: false, hasStorageClass: true, canPresignUrl: true };

const now = Math.floor(Date.now() / 1000);
const apply = async () => {};

const nginxConf: ExplorerEntry = {
  name: "nginx.conf", id: "/etc/nginx/nginx.conf", entryType: "File", size: 2_431, modified: now - 3 * 86400,
  permissionsDisplay: "-rw-r--r--", permissions: 0o644, isSymlink: false, storageClass: null,
};
const sharedDir: ExplorerEntry = {
  name: "shared", id: "/srv/www/releases/shared", entryType: "Directory", size: 4096, modified: now - 6 * 3600,
  permissionsDisplay: "drwxrwsr-x", permissions: 0o2775, isSymlink: false, storageClass: null,
};
const symlink: ExplorerEntry = {
  name: "current", id: "/srv/www/current", entryType: "File", size: 32, modified: now - 40 * 60,
  permissionsDisplay: "lrwxrwxrwx", permissions: 0o777, isSymlink: true, storageClass: null,
};
const s3Object: ExplorerEntry = {
  name: "release-2025-q4.tar.gz", id: "backups/releases/release-2025-q4.tar.gz", entryType: "File", size: 1_204_882_112,
  modified: now - 280 * 86400, permissionsDisplay: null, permissions: null, isSymlink: false, storageClass: "GLACIER",
};


// Modal overlays use `position: fixed; inset: 0`; give them a sized, transformed
// containing block so the backdrop fills the cell instead of the content height.
const Stage = ({ children }: { children: React.ReactNode }) => (
  <div className="font-sans bg-bg-base" style={{ width: 912, height: 632, transform: "translateZ(0)" }}>{children}</div>
);

export const ConfigFile = () => <Stage><FilePropertiesDialog entry={nginxConf} capabilities={SFTP_CAPS} onApplyPermissions={apply} onClose={noop} /></Stage>;
export const SetgidDirectory = () => <Stage><FilePropertiesDialog entry={sharedDir} capabilities={SFTP_CAPS} onApplyPermissions={apply} onClose={noop} /></Stage>;
export const Symlink = () => <Stage><FilePropertiesDialog entry={symlink} capabilities={SFTP_CAPS} onApplyPermissions={apply} onClose={noop} /></Stage>;
export const S3Object = () => <Stage><FilePropertiesDialog entry={s3Object} capabilities={S3_CAPS} onClose={noop} /></Stage>;
