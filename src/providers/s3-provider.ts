import type { S3Entry } from "../types/s3";
import type { ExplorerEntry, ProviderCapabilities, FileSystemProvider } from "../types/explorer";

export function toS3ExplorerEntry(e: S3Entry): ExplorerEntry {
  return {
    name: e.name,
    id: e.key,
    entryType: e.entry_type,
    size: e.size,
    modified: e.last_modified
      ? Math.floor(new Date(e.last_modified).getTime() / 1000)
      : null,
    permissionsDisplay: null,
    isSymlink: false,
    storageClass: e.storage_class,
  };
}

const S3_CAPABILITIES: ProviderCapabilities = {
  canRename: false,
  canCreateFile: true,
  canCreateFolder: true,
  canDelete: true,
  canUpload: true,
  canDownload: true,
  canDragDropUpload: true,
  canInternalDragMove: false,
  canCopyPaste: false,
  canEditInEditor: true,
  canGetInfo: true,
  hasPermissions: false,
  hasStorageClass: true,
  canPresignUrl: true,
};

export function createS3Provider(
  sessionId: string,
  bucketName: string,
): FileSystemProvider {
  return {
    type: "s3",
    sessionId,
    capabilities: S3_CAPABILITIES,
    joinPath(parent: string, child: string): string {
      if (!parent) return child;
      return parent.endsWith("/") ? `${parent}${child}` : `${parent}/${child}`;
    },
    parentPath(path: string): string {
      const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
      const idx = trimmed.lastIndexOf("/");
      return idx < 0 ? "" : trimmed.substring(0, idx + 1);
    },
    rootLabel(): string {
      return bucketName;
    },
  };
}
