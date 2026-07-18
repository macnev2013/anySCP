import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Upload,
  FolderUp,
  FolderPlus,
  FilePlus,
  RefreshCw,
  ChevronRight,
  Home,
  Loader2,
  Shield,
} from "lucide-react";
import type { FileSystemProvider } from "../../types/explorer";

interface BreadcrumbSegment {
  label: string;
  path: string;
}

interface ExplorerToolbarProps {
  provider: FileSystemProvider;
  currentPath: string;
  segments: BreadcrumbSegment[];
  loading: boolean;
  onRefresh: () => void;
  onNewFolder: () => void;
  onNewFile: () => void;
  onNavigate: (path: string) => void;
  onUpload: () => void;
  /** Optional folder-upload action. When provided, a companion "Upload folder"
   *  button is shown next to the file-upload button (mirrors New file/New
   *  folder). Transports without recursive upload can leave it undefined. */
  onUploadFolder?: () => void;
  busy?: boolean;
  sudoMode?: boolean;
  sudoBusy?: boolean;
  onToggleSudo?: () => void;
}

// cache icons so they render once
const ICON_BTN_CLASS = [
  "flex items-center justify-center w-7 h-7 rounded-md shrink-0",
  "text-text-muted hover:text-text-secondary hover:bg-bg-subtle",
  "transition-colors duration-[var(--duration-fast)]",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  "disabled:opacity-40 disabled:cursor-not-allowed",
].join(" ");
const PATH_INPUT_CLASS = [
  "flex-1 min-w-0 mx-1 px-1.5 py-0.5 rounded",
  "bg-bg-subtle text-text-primary text-[length:var(--text-sm)]",
  "border border-ring outline-none",
].join(" ");
const BREADCRUMB_BAR_CLASS =
  "flex items-center gap-0 overflow-x-auto flex-1 min-w-0 mx-1 cursor-text rounded hover:bg-bg-subtle/40";
const SEGMENT_BTN_BASE_CLASS = [
  "px-1 py-0.5 rounded text-[length:var(--text-sm)]",
  "transition-colors duration-[var(--duration-fast)]",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
].join(" ");
const SEGMENT_BTN_LAST_CLASS = "text-text-primary font-medium cursor-default";
const SEGMENT_BTN_LINK_CLASS =
  "text-text-muted hover:text-text-secondary hover:bg-bg-subtle/70 cursor-pointer";

/**
 * Normalize a hand-typed path to the provider's convention: SFTP paths are
 * absolute with no trailing slash; S3 prefixes have no leading slash and a
 * trailing one ("a/b/"), matching how the breadcrumb segments are built —
 * listing uses the "/" delimiter, so a prefix without it would show the
 * folder itself instead of its contents.
 */
function normalizePath(
  providerType: FileSystemProvider["type"],
  raw: string,
): string {
  const trimmed = raw.trim();
  if (providerType === "sftp") {
    const stripped = trimmed.replace(/\/+$/, "");
    if (stripped === "") return "/";
    return stripped.startsWith("/") ? stripped : `/${stripped}`;
  }
  const prefix = trimmed.replace(/^\/+/, "");
  return prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix;
}

export const ExplorerToolbar = memo(function ExplorerToolbar({
  provider,
  currentPath,
  segments,
  loading,
  onRefresh,
  onNewFolder,
  onNewFile,
  onNavigate,
  onUpload,
  onUploadFolder,
  busy,
  sudoMode,
  sudoBusy,
  onToggleSudo,
}: ExplorerToolbarProps) {
  const caps = provider.capabilities;
  const providerType = provider.type;

  const [isEditing, setIsEditing] = useState(false);
  const [draftPath, setDraftPath] = useState(currentPath);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus + select only when editing begins — re-running on a currentPath
  // change mid-edit would stomp the user's cursor/selection
  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  // Keep the draft in sync with the real path while not editing
  useEffect(() => {
    if (!isEditing) setDraftPath(currentPath);
  }, [isEditing, currentPath]);
  const beginEdit = useCallback(() => {
    if (loading) return;
    setDraftPath(currentPath);
    setIsEditing(true);
  }, [loading, currentPath]);
  const commitEdit = useCallback(() => {
    setIsEditing(false);
    const trimmed = draftPath.trim();
    if (trimmed.length > 0 && trimmed !== currentPath) {
      const normalized = normalizePath(providerType, trimmed);
      if (normalized !== currentPath) onNavigate(normalized);
    }
  }, [draftPath, currentPath, providerType, onNavigate]);
  const cancelEdit = useCallback(() => {
    setDraftPath(currentPath);
    setIsEditing(false);
  }, [currentPath]);
  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        inputRef.current?.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelEdit();
      }
    },
    [cancelEdit],
  );
  const handleHome = useCallback(
    () => onNavigate(providerType === "sftp" ? "/" : ""),
    [onNavigate, providerType],
  );
  const isAtRoot =
    providerType === "sftp" ? currentPath === "/" : currentPath === "";

  return (
    <div className="flex items-center h-10 px-2 border-b border-border bg-bg-surface shrink-0 gap-1 no-select">
      {/* Home button */}
      <button
        data-testid="explorer-home"
        onClick={handleHome}
        disabled={loading || isAtRoot}
        title={`Go to ${provider.rootLabel()}`}
        aria-label="Go to root"
        className={ICON_BTN_CLASS}
      >
        <Home size={15} strokeWidth={1.8} aria-hidden="true" />
      </button>

      {/* Breadcrumb path */}
      {isEditing ? (
        <input
          ref={inputRef}
          data-testid="explorer-path-input"
          type="text"
          value={draftPath}
          onChange={(e) => setDraftPath(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={handleInputKeyDown}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          aria-label="Edit current path"
          className={PATH_INPUT_CLASS}
        />
      ) : (
        <div
          onClick={beginEdit}
          // Keyboard path to edit mode: the bar itself is focusable and Enter
          // begins editing (segment buttons keep their own click behavior).
          // No role="button" — it contains real buttons, and nesting
          // interactive roles is an ARIA violation.
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.target === e.currentTarget) {
              e.preventDefault();
              beginEdit();
            }
          }}
          title="Click to type a path"
          aria-label="Current path"
          className={`${BREADCRUMB_BAR_CLASS} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
        >
          {segments.map((seg, index) => {
            const isLast = index === segments.length - 1;
            const isRoot = index === 0;

            return (
              <span
                key={`${seg.path}-${index}`}
                className="flex items-center shrink-0"
              >
                {!isRoot && (
                  <ChevronRight
                    size={12}
                    strokeWidth={2}
                    className="text-text-muted/50 mx-0.5 shrink-0"
                    aria-hidden="true"
                  />
                )}
                <button
                  onClick={(e) => {
                    // Segment clicks navigate directly; don't let the click bubble up and open edit mode on the same action.
                    e.stopPropagation();
                    if (!isLast) onNavigate(seg.path);
                  }}
                  disabled={isLast}
                  title={isLast ? seg.path : `Navigate to ${seg.path}`}
                  className={`${SEGMENT_BTN_BASE_CLASS} ${isLast ? SEGMENT_BTN_LAST_CLASS : SEGMENT_BTN_LINK_CLASS}`}
                >
                  {isRoot ? provider.rootLabel() : seg.label}
                </button>
              </span>
            );
          })}
          {/* Fills remaining empty space so clicking past the last segment still opens edit mode */}
          <span className="flex-1 min-w-2 h-full" />
        </div>
      )}

      {/* Busy spinner */}
      {busy && (
        <Loader2
          size={15}
          strokeWidth={2}
          className="text-accent motion-safe:animate-spin shrink-0"
          aria-label="Operation in progress"
        />
      )}

      {/* Separator */}
      <span className="w-px h-4 bg-border shrink-0" aria-hidden="true" />

      {/* Upload file */}
      {caps.canUpload && (
        <button
          data-testid="explorer-upload"
          onClick={onUpload}
          disabled={loading}
          title="Upload files"
          aria-label="Upload files"
          className={ICON_BTN_CLASS}
        >
          <Upload size={15} strokeWidth={1.8} aria-hidden="true" />
        </button>
      )}

      {/* Upload folder */}
      {caps.canUpload && onUploadFolder && (
        <button
          data-testid="explorer-upload-folder"
          onClick={onUploadFolder}
          disabled={loading}
          title="Upload folder"
          aria-label="Upload folder"
          className={ICON_BTN_CLASS}
        >
          <FolderUp size={15} strokeWidth={1.8} aria-hidden="true" />
        </button>
      )}

      {/* New file */}
      {caps.canCreateFile && (
        <button
          data-testid="explorer-new-file"
          onClick={onNewFile}
          disabled={loading}
          title="New file"
          aria-label="New file"
          className={ICON_BTN_CLASS}
        >
          <FilePlus size={15} strokeWidth={1.8} aria-hidden="true" />
        </button>
      )}

      {/* New folder */}
      {caps.canCreateFolder && (
        <button
          data-testid="explorer-new-folder"
          onClick={onNewFolder}
          disabled={loading}
          title="New folder"
          aria-label="New folder"
          className={ICON_BTN_CLASS}
        >
          <FolderPlus size={15} strokeWidth={1.8} aria-hidden="true" />
        </button>
      )}

      {/* Refresh */}
      <button
        data-testid="explorer-refresh"
        onClick={onRefresh}
        disabled={loading}
        title="Refresh"
        aria-label="Refresh"
        className={ICON_BTN_CLASS}
      >
        <RefreshCw
          size={15}
          strokeWidth={1.8}
          aria-hidden="true"
          className={loading ? "motion-safe:animate-spin" : ""}
        />
      </button>

      {onToggleSudo && (
        <button
          data-testid="explorer-sudo-toggle"
          onClick={onToggleSudo}
          disabled={sudoBusy}
          aria-busy={sudoBusy}
          title={sudoMode ? "Disable sudo mode" : "Enable sudo mode"}
          aria-label={sudoMode ? "Disable sudo mode" : "Enable sudo mode"}
          aria-pressed={!!sudoMode}
          className={
            sudoMode
              ? `${ICON_BTN_CLASS} text-accent bg-accent/15 hover:bg-accent/25 hover:text-accent`
              : ICON_BTN_CLASS
          }
        >
          {sudoBusy ? (
            <Loader2
              size={15}
              strokeWidth={1.8}
              aria-hidden="true"
              className="motion-safe:animate-spin"
            />
          ) : (
            <Shield size={15} strokeWidth={1.8} aria-hidden="true" />
          )}
        </button>
      )}
    </div>
  );
});
