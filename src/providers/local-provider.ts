import { invoke } from "@tauri-apps/api/core";
import type { SftpEntry } from "../types/sftp";
import type { ProviderCapabilities, FileSystemProvider, DragOutResult } from "../types/explorer";
import type { EditorConfig } from "../stores/settings-store";
import { toExplorerEntry } from "./sftp-provider";

// Local paths are native to the OS: `/` on Unix, `\` on Windows. `local_*`
// commands return native paths, so path-joining must match. Detect once.
const SEP =
  typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent) ? "\\" : "/";

// Transfers are cross-pane (driven by the remote provider), so
// canUpload/canDownload are off here; presign is S3-only.
//
// `hasPermissions` is on so the Unix mode column renders (Windows reports 0 → a
// blank cell); read-only, since the provider has no `chmod`.
// `canEditInEditor` is on: local files edit in place (no download/watch round-trip).
const LOCAL_CAPABILITIES: ProviderCapabilities = {
  canRename: true,
  canCreateFile: true,
  canCreateFolder: true,
  canDelete: true,
  canUpload: false,
  canDownload: false,
  // Accepts OS file drops: the dropped paths are already local, so the pane
  // copies them into the target dir (dedupes, never clobbers) rather than
  // uploading.
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
 * Provider for the local filesystem pane. `paneKey` is only a state key (local
 * commands are stateless); it lets each dual-pane tab keep its own cwd.
 */
export function createLocalProvider(paneKey: string): FileSystemProvider {
  return {
    type: "local",
    sessionId: paneKey,
    capabilities: LOCAL_CAPABILITIES,

    joinPath(parent, child) {
      if (!parent) return child;
      return parent.endsWith(SEP) ? `${parent}${child}` : `${parent}${SEP}${child}`;
    },
    parentPath(path) {
      const trimmed = path.length > 1 && path.endsWith(SEP) ? path.slice(0, -1) : path;
      const idx = trimmed.lastIndexOf(SEP);
      if (idx < 0) return trimmed;
      // Keep the leading separator so `/a` → `/`, not "".
      return idx === 0 ? SEP : trimmed.substring(0, idx);
    },
    rootLabel() {
      return SEP;
    },
    breadcrumbs(path) {
      const parts = path.split(SEP).filter(Boolean);
      return [
        { label: SEP, path: SEP },
        ...parts.map((seg, i) => ({ label: seg, path: SEP + parts.slice(0, i + 1).join(SEP) })),
      ];
    },

    async listDir(path) {
      const entries = await invoke<SftpEntry[]>("local_list_dir", { path });
      return entries.map(toExplorerEntry);
    },
    homeDir() {
      return invoke<string>("local_home_dir");
    },
    mkdir(path) {
      return invoke("local_mkdir", { path });
    },
    createFile(path) {
      return invoke("local_create_file", { path });
    },
    delete(entry) {
      return invoke("local_delete", { path: entry.id, isDir: entry.entryType === "Directory" });
    },
    rename(entry, newPath) {
      return invoke("local_rename", { oldPath: entry.id, newPath });
    },
    editInEditor(entry, editor: EditorConfig | null) {
      return invoke("local_edit", { path: entry.id, editor });
    },
    move(sourceIds, targetDir) {
      return invoke("local_move", { sourcePaths: sourceIds, targetDir });
    },
    copy(sourceIds, targetDir) {
      return invoke("local_copy", { sourcePaths: sourceIds, targetDir });
    },
    dragOut(entryIds) {
      // Local files are already on disk, so the drag hands their real paths to
      // the OS — no staging (unlike the SFTP provider's download-first dragOut).
      return invoke<DragOutResult>("local_drag_out", { paths: entryIds });
    },
  };
}
