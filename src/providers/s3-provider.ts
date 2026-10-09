import { invoke } from "@tauri-apps/api/core";
import type { S3Entry, S3ListResult } from "../types/s3";
import type { ExplorerEntry, ProviderCapabilities, FileSystemProvider } from "../types/explorer";
import type { EditorConfig } from "../stores/settings-store";

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
    permissions: null,
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

    joinPath(parent, child) {
      if (!parent) return child;
      return parent.endsWith("/") ? `${parent}${child}` : `${parent}/${child}`;
    },
    parentPath(path) {
      const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
      const idx = trimmed.lastIndexOf("/");
      return idx < 0 ? "" : trimmed.substring(0, idx + 1);
    },
    rootLabel() {
      return bucketName;
    },
    breadcrumbs(prefix) {
      const parts = prefix.split("/").filter(Boolean);
      return [
        { label: bucketName, path: "" },
        ...parts.map((seg, i) => ({ label: seg, path: parts.slice(0, i + 1).join("/") + "/" })),
      ];
    },

    async listDir(prefix) {
      const result = await invoke<S3ListResult>("s3_list_objects", {
        s3SessionId: sessionId,
        prefix,
        continuationToken: null,
      });
      return result.entries.map(toS3ExplorerEntry);
    },
    // S3 has no home; the root is the empty prefix.
    async homeDir() {
      return "";
    },
    mkdir(path) {
      // S3 "folders" are zero-length marker keys, so they must end in "/".
      const prefix = path.endsWith("/") ? path : `${path}/`;
      return invoke("s3_create_folder", { s3SessionId: sessionId, prefix });
    },
    createFile(key) {
      return invoke("s3_create_file", { s3SessionId: sessionId, key });
    },
    delete(entry) {
      return entry.entryType === "Directory"
        ? invoke("s3_delete_prefix", { s3SessionId: sessionId, prefix: entry.id })
        : invoke("s3_delete_object", { s3SessionId: sessionId, key: entry.id });
    },
    editInEditor(entry, editor: EditorConfig | null) {
      return invoke("s3_edit_external", { s3SessionId: sessionId, key: entry.id, editor });
    },
    presignUrl(entry) {
      return invoke<string>("s3_presign_url", { s3SessionId: sessionId, key: entry.id, expirySecs: 3600 });
    },
    downloadAs(entry, localPath) {
      return invoke("s3_enqueue_download_as", { s3SessionId: sessionId, key: entry.id, localPath });
    },
    enqueueUpload(localPaths, targetDir) {
      return invoke<string[]>("s3_enqueue_upload", { s3SessionId: sessionId, localPaths, prefix: targetDir });
    },
    enqueueDownload(entryIds, localDir) {
      return invoke<string[]>("s3_enqueue_download", { s3SessionId: sessionId, keys: entryIds, localDir });
    },
  };
}
