import { Upload, FolderPlus, FilePlus, RefreshCw, ChevronRight, Home, Loader2, Shield } from "lucide-react";
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
  busy?: boolean;
  sudoMode?: boolean;
  sudoBusy?: boolean;
  onToggleSudo?: () => void;
}

export function ExplorerToolbar({
  provider,
  currentPath,
  segments,
  loading,
  onRefresh,
  onNewFolder,
  onNewFile,
  onNavigate,
  onUpload,
  busy,
  sudoMode,
  sudoBusy,
  onToggleSudo,
}: ExplorerToolbarProps) {
  const caps = provider.capabilities;

  const iconBtn = [
    "flex items-center justify-center w-7 h-7 rounded-md shrink-0",
    "text-text-muted hover:text-text-secondary hover:bg-bg-subtle",
    "transition-colors duration-[var(--duration-fast)]",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    "disabled:opacity-40 disabled:cursor-not-allowed",
  ].join(" ");

  const isAtRoot = provider.type === "sftp"
    ? currentPath === "/"
    : currentPath === "";

  return (
    <div className="flex items-center h-10 px-2 border-b border-border bg-bg-surface shrink-0 gap-1 no-select">
      {/* Home button */}
      <button
        data-testid="explorer-home"
        onClick={() => onNavigate(provider.type === "sftp" ? "/" : "")}
        disabled={loading || isAtRoot}
        title={`Go to ${provider.rootLabel()}`}
        aria-label="Go to root"
        className={iconBtn}
      >
        <Home size={15} strokeWidth={1.8} aria-hidden="true" />
      </button>

      {/* Breadcrumb path */}
      <div
        className="flex items-center gap-0 overflow-x-auto flex-1 min-w-0 mx-1"
        aria-label="Current path"
      >
        {segments.map((seg, index) => {
          const isLast = index === segments.length - 1;
          const isRoot = index === 0;

          return (
            <span key={`${seg.path}-${index}`} className="flex items-center shrink-0">
              {!isRoot && (
                <ChevronRight
                  size={12}
                  strokeWidth={2}
                  className="text-text-muted/50 mx-0.5 shrink-0"
                  aria-hidden="true"
                />
              )}
              <button
                onClick={() => !isLast && onNavigate(seg.path)}
                disabled={isLast}
                title={isLast ? seg.path : `Navigate to ${seg.path}`}
                className={[
                  "px-1 py-0.5 rounded text-[length:var(--text-sm)]",
                  "transition-colors duration-[var(--duration-fast)]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isLast
                    ? "text-text-primary font-medium cursor-default"
                    : "text-text-muted hover:text-text-secondary hover:bg-bg-subtle/70 cursor-pointer",
                ].join(" ")}
              >
                {isRoot ? provider.rootLabel() : seg.label}
              </button>
            </span>
          );
        })}
      </div>

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

      {/* Upload */}
      {caps.canUpload && (
        <button
          data-testid="explorer-upload"
          onClick={onUpload}
          disabled={loading}
          title="Upload file"
          aria-label="Upload file"
          className={iconBtn}
        >
          <Upload size={15} strokeWidth={1.8} aria-hidden="true" />
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
          className={iconBtn}
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
          className={iconBtn}
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
        className={iconBtn}
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
          className={[
            iconBtn,
            sudoMode
              ? "text-accent bg-accent/15 hover:bg-accent/25 hover:text-accent"
              : "",
          ].join(" ")}
        >
          {sudoBusy ? (
            <Loader2 size={15} strokeWidth={1.8} aria-hidden="true" className="motion-safe:animate-spin" />
          ) : (
            <Shield size={15} strokeWidth={1.8} aria-hidden="true" />
          )}
        </button>
      )}
    </div>
  );
}
