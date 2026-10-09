import type { SftpEntry } from "../types/sftp";
import type {
  ExplorerEntry,
  ProviderCapabilities,
  FileSystemProvider,
  ChmodResult,
  DragOutResult,
} from "../types/explorer";
import type { EditorConfig } from "../stores/settings-store";
import { explorerInvoke, type Transport } from "../lib/explorer-transport";

export function toExplorerEntry(e: SftpEntry): ExplorerEntry {
  return {
    name: e.name,
    id: e.path,
    entryType: e.entry_type === "Directory" ? "Directory" : "File",
    size: e.size,
    modified: e.modified,
    permissionsDisplay: e.permissions_display,
    permissions: e.permissions,
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

/**
 * Provider for SFTP and its SCP fallback — they share one command surface,
 * differing only in the `sftp_`/`scp_` prefix handled by `explorerInvoke`.
 */
export function createSftpProvider(
  sessionId: string,
  transport: Transport = "sftp",
): FileSystemProvider {
  const isDir = (e: ExplorerEntry) => e.entryType === "Directory";

  return {
    type: transport,
    sessionId,
    capabilities: SFTP_CAPABILITIES,

    joinPath(parent, child) {
      return parent.endsWith("/") ? `${parent}${child}` : `${parent}/${child}`;
    },
    parentPath(path) {
      const idx = path.lastIndexOf("/");
      return idx <= 0 ? "/" : path.substring(0, idx);
    },
    rootLabel() {
      return "/";
    },
    breadcrumbs(path) {
      const parts = path.split("/").filter(Boolean);
      return [
        { label: "/", path: "/" },
        ...parts.map((seg, i) => ({ label: seg, path: "/" + parts.slice(0, i + 1).join("/") })),
      ];
    },

    async listDir(path) {
      const entries = await explorerInvoke<SftpEntry[]>(transport, "list_dir", sessionId, { path });
      return entries.map(toExplorerEntry);
    },
    homeDir() {
      return explorerInvoke<string>(transport, "home_dir", sessionId);
    },
    mkdir(path) {
      return explorerInvoke(transport, "mkdir", sessionId, { path });
    },
    createFile(path) {
      return explorerInvoke(transport, "create_file", sessionId, { path });
    },
    delete(entry) {
      return explorerInvoke(transport, "delete", sessionId, { path: entry.id, isDir: isDir(entry) });
    },
    rename(entry, newPath) {
      return explorerInvoke(transport, "rename", sessionId, { oldPath: entry.id, newPath });
    },
    async chmod(entry, mode, recursive) {
      if (recursive && isDir(entry)) {
        return explorerInvoke<ChmodResult>(transport, "chmod_recursive", sessionId, { path: entry.id, mode });
      }
      await explorerInvoke(transport, "chmod", sessionId, { path: entry.id, mode });
      return undefined;
    },
    editInEditor(entry, editor: EditorConfig | null) {
      return explorerInvoke(transport, "edit_external", sessionId, { remotePath: entry.id, editor });
    },
    move(sourceIds, targetDir) {
      return explorerInvoke(transport, "move_entries", sessionId, { sourcePaths: sourceIds, targetDir });
    },
    copy(sourceIds, targetDir) {
      return explorerInvoke(transport, "copy_entries", sessionId, { sourcePaths: sourceIds, targetDir });
    },
    dragOut(entryIds) {
      return explorerInvoke<DragOutResult>(transport, "drag_out", sessionId, { remotePaths: entryIds });
    },
    downloadAs(entry, localPath) {
      return explorerInvoke(transport, "download", sessionId, { remotePath: entry.id, localPath });
    },
    enqueueDownload(entryIds, localDir) {
      return explorerInvoke<string[]>(transport, "enqueue_download", sessionId, { remotePaths: entryIds, localDir });
    },
    enqueueUpload(localPaths, targetDir) {
      return explorerInvoke<string[]>(transport, "enqueue_upload", sessionId, { localPaths, remoteDir: targetDir });
    },
  };
}
