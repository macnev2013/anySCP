import type { SftpEntry } from "../types/sftp";
import type { ExplorerEntry, ProviderCapabilities, FileSystemProvider } from "../types/explorer";

export function toExplorerEntry(e: SftpEntry): ExplorerEntry {
  return {
    name: e.name,
    id: e.path,
    entryType: e.entry_type === "Directory" ? "Directory" : "File",
    size: e.size,
    modified: e.modified,
    permissionsDisplay: e.permissions_display,
    isSymlink: e.is_symlink,
    storageClass: null,
  };
}

const SFTP_CAPABILITIES: ProviderCapabilities = {
  canRename: true,
  canCreateFile: true,
  canCreateFolder: true,
  canDelete: true,
  canUpload: true,
  canDownload: true,
  canDragDropUpload: true,
  canInternalDragMove: true,
  canCopyPaste: true,
  canEditInEditor: true,
  canGetInfo: true,
  hasPermissions: true,
  hasStorageClass: false,
  canPresignUrl: false,
};

export function createSftpProvider(sftpSessionId: string): FileSystemProvider {
  return {
    type: "sftp",
    sessionId: sftpSessionId,
    capabilities: SFTP_CAPABILITIES,
    joinPath(parent: string, child: string): string {
      return parent.endsWith("/") ? `${parent}${child}` : `${parent}/${child}`;
    },
    parentPath(path: string): string {
      const idx = path.lastIndexOf("/");
      return idx <= 0 ? "/" : path.substring(0, idx);
    },
    rootLabel(): string {
      return "/";
    },
  };
}
