import { useState, useEffect, useRef, useCallback } from "react";
import {
  Folder,
  FileText,
  Link as LinkIcon,
  File,
  ChevronUp,
  ChevronDown,
  Download,
  Pencil,
  Trash2,
  Copy,
  Scissors,
  ClipboardPaste,
  FolderPlus,
  FilePlus,
  ExternalLink,
  Info,
  X,
  Link2,
} from "lucide-react";
import type { ExplorerEntry, ExplorerClipboard, FileSystemProvider } from "../../types/explorer";
import { ContextMenu } from "../shared/ContextMenu";
import type { ContextMenuItem } from "../shared/ContextMenu";
import { formatBytes } from "../../utils/format";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExplorerFileTableProps {
  provider: FileSystemProvider;
  entries: ExplorerEntry[];
  sortBy: "name" | "size" | "modified";
  sortAsc: boolean;
  onSortChange: (sortBy: "name" | "size" | "modified", sortAsc: boolean) => void;
  clipboard: ExplorerClipboard | null;
  onSetClipboard: (clipboard: ExplorerClipboard | null) => void;
  onNavigate: (path: string) => void;
  onDownload: (entry: ExplorerEntry) => void;
  onDelete: (entries: ExplorerEntry[]) => Promise<void>;
  onRename?: (entry: ExplorerEntry, newName: string) => Promise<void>;
  onEditInEditor?: (entry: ExplorerEntry) => void;
  onPresignUrl?: (entry: ExplorerEntry) => void;
  onGetInfo?: (entry: ExplorerEntry) => void;
  creatingFile?: boolean;
  onCreateFile?: (name: string) => void;
  onCancelCreateFile?: () => void;
  creatingFolder?: boolean;
  onCreateFolder?: (name: string) => void;
  onCancelCreateFolder?: () => void;
  onPaste?: () => void;
  onMoveEntries?: (sourceIds: string[], targetDir: string) => Promise<void>;
  onCopyEntries?: (sourceIds: string[], targetDir: string) => Promise<void>;
  loading?: boolean;
  busy?: boolean;
}

interface ContextMenuState {
  entry: ExplorerEntry | null;
  x: number;
  y: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatModified(unix: number | null): string {
  if (unix === null) return "—";
  const d = new Date(unix * 1000);
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 30) return `${diffDays}d ago`;
  if (diffDays < 365) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function EntryIcon({ entry }: { entry: ExplorerEntry }) {
  if (entry.isSymlink) {
    return <LinkIcon size={15} strokeWidth={1.8} className="text-accent shrink-0" aria-hidden="true" />;
  }
  switch (entry.entryType) {
    case "Directory":
      return <Folder size={15} strokeWidth={1.8} className="text-accent shrink-0" aria-hidden="true" />;
    case "File":
      return <FileText size={15} strokeWidth={1.6} className="text-text-muted shrink-0" aria-hidden="true" />;
    default:
      return <File size={15} strokeWidth={1.6} className="text-text-muted shrink-0" aria-hidden="true" />;
  }
}

// ─── Inline rename row ────────────────────────────────────────────────────────

function RenameRow({
  entry,
  onRename,
  onDone,
}: {
  entry: ExplorerEntry;
  onRename: (entry: ExplorerEntry, newName: string) => Promise<void>;
  onDone: () => void;
}) {
  const [value, setValue] = useState(entry.name);
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = useCallback(async () => {
    const newName = value.trim();
    if (!newName || newName === entry.name) {
      onDone();
      return;
    }
    try {
      await onRename(entry, newName);
    } catch (err) {
      console.error("Rename failed:", err);
    } finally {
      onDone();
    }
  }, [value, entry, onRename, onDone]);

  return (
    <input
      ref={inputRef}
      autoFocus
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") void commit();
        if (e.key === "Escape") onDone();
      }}
      onClick={(e) => e.stopPropagation()}
      className={[
        "w-full px-1.5 py-0.5 rounded text-[length:var(--text-sm)] text-text-primary",
        "bg-bg-base border border-border-focus outline-none ring-2 ring-ring",
        "transition-[border-color,box-shadow] duration-[var(--duration-fast)]",
      ].join(" ")}
      aria-label="Rename file"
    />
  );
}

// ─── New folder inline row ────────────────────────────────────────────────────

function NewFolderRow({
  onCommit,
  onCancel,
}: {
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const commit = () => {
    const name = value.trim();
    if (name) onCommit(name); else onCancel();
  };

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-accent/5">
      <span className="w-5 flex items-center justify-center shrink-0">
        <Folder size={15} strokeWidth={1.8} className="text-accent" aria-hidden="true" />
      </span>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") onCancel();
        }}
        placeholder="Folder name"
        className={[
          "flex-1 px-1.5 py-0.5 rounded text-[length:var(--text-sm)] text-text-primary",
          "bg-bg-base border border-border-focus outline-none ring-2 ring-ring",
          "transition-[border-color,box-shadow] duration-[var(--duration-fast)]",
        ].join(" ")}
        aria-label="New folder name"
      />
      <span className="w-20" />
      <span className="w-32" />
      <span className="w-24" />
    </div>
  );
}

function NewFileRow({
  onCommit,
  onCancel,
}: {
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const commit = () => {
    const name = value.trim();
    if (name) onCommit(name); else onCancel();
  };

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-accent/5">
      <span className="w-5 flex items-center justify-center shrink-0">
        <FileText size={15} strokeWidth={1.6} className="text-text-muted" aria-hidden="true" />
      </span>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") onCancel();
        }}
        placeholder="file.txt"
        className={[
          "flex-1 px-1.5 py-0.5 rounded text-[length:var(--text-sm)] text-text-primary",
          "bg-bg-base border border-border-focus outline-none ring-2 ring-ring",
          "transition-[border-color,box-shadow] duration-[var(--duration-fast)]",
        ].join(" ")}
        aria-label="New file name"
      />
      <span className="w-20" />
      <span className="w-32" />
      <span className="w-24" />
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ExplorerFileTable({
  provider,
  entries,
  sortBy,
  sortAsc,
  onSortChange,
  clipboard,
  onSetClipboard,
  onNavigate,
  onDownload,
  onDelete,
  onRename,
  onEditInEditor,
  onPresignUrl,
  onGetInfo,
  creatingFolder,
  onCreateFolder,
  onCancelCreateFolder,
  creatingFile,
  onCreateFile,
  onCancelCreateFile,
  onPaste,
  onMoveEntries,
  onCopyEntries,
  loading,
}: ExplorerFileTableProps) {
  const caps = provider.capabilities;
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ExplorerEntry[] | null>(null);
  const [infoEntry, setInfoEntry] = useState<ExplorerEntry | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastClickedId = useRef<string | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  // Drag-and-drop state (internal move)
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const draggedEntriesRef = useRef<ExplorerEntry[]>([]);
  const dragEnterCountRef = useRef(0);

  // Cut entry dimming
  const cutIds = clipboard?.operation === "cut" && clipboard.sourceSessionId === provider.sessionId
    ? new Set(clipboard.entries.map((e) => e.id))
    : null;

  // ─── Sort ─────────────────────────────────────────────────────────────────

  const sortedEntries = [...entries].sort((a, b) => {
    const aIsDir = a.entryType === "Directory";
    const bIsDir = b.entryType === "Directory";
    if (aIsDir && !bIsDir) return -1;
    if (!aIsDir && bIsDir) return 1;

    let cmp = 0;
    if (sortBy === "name") {
      cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    } else if (sortBy === "size") {
      cmp = a.size - b.size;
    } else {
      cmp = (a.modified ?? 0) - (b.modified ?? 0);
    }
    return sortAsc ? cmp : -cmp;
  });

  const handleSortClick = (col: "name" | "size" | "modified") => {
    if (sortBy === col) {
      onSortChange(col, !sortAsc);
    } else {
      onSortChange(col, true);
    }
  };

  // ─── Selection ───────────────────────────────────────────────────────────

  const handleRowClick = (entry: ExplorerEntry, e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id);
        return next;
      });
    } else if (e.shiftKey && lastClickedId.current) {
      const ids = sortedEntries.map((e) => e.id);
      const startIdx = ids.indexOf(lastClickedId.current);
      const endIdx = ids.indexOf(entry.id);
      if (startIdx >= 0 && endIdx >= 0) {
        const from = Math.min(startIdx, endIdx);
        const to = Math.max(startIdx, endIdx);
        setSelectedIds((prev) => {
          const next = new Set(prev);
          for (let i = from; i <= to; i++) next.add(ids[i]);
          return next;
        });
      }
    } else {
      setSelectedIds(new Set([entry.id]));
    }
    lastClickedId.current = entry.id;
  };

  const selectedEntries = sortedEntries.filter((e) => selectedIds.has(e.id));

  // ─── Row actions ──────────────────────────────────────────────────────────

  const handleDoubleClick = (entry: ExplorerEntry) => {
    if (entry.entryType === "Directory") {
      onNavigate(entry.id);
    } else {
      onDownload(entry);
    }
  };

  const handleContextMenu = (e: React.MouseEvent, entry: ExplorerEntry | null) => {
    e.preventDefault();
    setContextMenu({ entry, x: e.clientX, y: e.clientY });
  };

  const handleDeleteEntries = async (entriesToDelete: ExplorerEntry[]) => {
    try {
      await onDelete(entriesToDelete);
      setSelectedIds(new Set());
    } finally {
      setConfirmDelete(null);
    }
  };

  // ─── Context menu items ───────────────────────────────────────────────────

  const canPaste = caps.canCopyPaste && clipboard !== null && clipboard.sourceSessionId === provider.sessionId;

  const buildMenuItems = (entry: ExplorerEntry | null): ContextMenuItem[] => {
    if (!entry) {
      const items: ContextMenuItem[] = [];
      if (canPaste) {
        items.push({ label: "Paste", icon: ClipboardPaste, onClick: () => onPaste?.() });
        items.push({ label: "", onClick: () => {}, separator: true, disabled: true });
      }
      if (caps.canCreateFile) {
        items.push({ label: "New File", icon: File, onClick: () => onCreateFile?.("") || document.dispatchEvent(new CustomEvent("explorer:new-file")) });
      }
      if (caps.canCreateFolder) {
        items.push({ label: "New Folder", icon: FolderPlus, onClick: () => onCreateFolder?.("") || document.dispatchEvent(new CustomEvent("explorer:new-folder")) });
      }
      return items;
    }

    // Multi-select context menu
    const isInSelection = selectedIds.has(entry.id) && selectedIds.size > 1;
    const items: ContextMenuItem[] = [];

    if (isInSelection) {
      const count = selectedIds.size;
      if (caps.canCopyPaste) {
        items.push({
          label: `Copy ${count} items`,
          icon: Copy,
          onClick: () => onSetClipboard({ entries: selectedEntries, operation: "copy", sourceSessionId: provider.sessionId }),
        });
        items.push({
          label: `Cut ${count} items`,
          icon: Scissors,
          onClick: () => onSetClipboard({ entries: selectedEntries, operation: "cut", sourceSessionId: provider.sessionId }),
        });
        if (canPaste) {
          items.push({ label: "Paste", icon: ClipboardPaste, onClick: () => onPaste?.() });
        }
      }
      if (caps.canDelete) {
        items.push({
          label: `Delete ${count} items`,
          icon: Trash2,
          separator: true,
          danger: true,
          onClick: () => setConfirmDelete(selectedEntries),
        });
      }
      return items;
    }

    // Single item context menu
    if (caps.canEditInEditor && entry.entryType !== "Directory") {
      items.push({
        label: "Edit in VS Code",
        icon: ExternalLink,
        onClick: () => onEditInEditor?.(entry),
      });
    }

    if (caps.canDownload) {
      if (entry.entryType !== "Directory") {
        items.push({ label: "Download", icon: Download, onClick: () => onDownload(entry) });
      } else if (provider.type === "sftp") {
        items.push({
          label: "Download Folder",
          icon: Download,
          onClick: () => onDownload(entry),
        });
      }
    }

    if (caps.canPresignUrl && entry.entryType === "File") {
      items.push({
        label: "Copy Presigned URL",
        icon: Link2,
        onClick: () => onPresignUrl?.(entry),
      });
    }

    if (caps.canRename) {
      items.push({ label: "Rename", icon: Pencil, onClick: () => setRenamingId(entry.id) });
    }

    items.push({
      label: "Copy Path",
      icon: Copy,
      onClick: () => void navigator.clipboard.writeText(entry.id),
    });

    if (caps.canCopyPaste) {
      items.push({
        label: "Copy",
        icon: Copy,
        separator: true,
        onClick: () => onSetClipboard({ entries: [entry], operation: "copy", sourceSessionId: provider.sessionId }),
      });
      items.push({
        label: "Cut",
        icon: Scissors,
        onClick: () => onSetClipboard({ entries: [entry], operation: "cut", sourceSessionId: provider.sessionId }),
      });
      if (canPaste) {
        items.push({ label: "Paste", icon: ClipboardPaste, onClick: () => onPaste?.() });
      }
    }

    if (caps.canGetInfo) {
      items.push({
        label: "Get Info",
        icon: Info,
        separator: true,
        onClick: () => {
          if (onGetInfo) {
            onGetInfo(entry);
          } else {
            setInfoEntry(entry);
          }
        },
      });
    }

    if (caps.canDelete) {
      items.push({
        label: "Delete",
        icon: Trash2,
        separator: true,
        danger: true,
        onClick: () => setConfirmDelete([entry]),
      });
    }

    return items;
  };

  // ─── Sort indicator ───────────────────────────────────────────────────────

  const SortIcon = ({ col }: { col: "name" | "size" | "modified" }) => {
    if (sortBy !== col) return null;
    return sortAsc
      ? <ChevronUp size={11} strokeWidth={2.5} className="inline ml-0.5" aria-hidden="true" />
      : <ChevronDown size={11} strokeWidth={2.5} className="inline ml-0.5" aria-hidden="true" />;
  };

  const thClass = (col: "name" | "size" | "modified") => [
    "text-left text-[length:var(--text-xs)] font-semibold uppercase tracking-wide text-text-muted",
    "cursor-pointer select-none hover:text-text-secondary transition-colors duration-[var(--duration-fast)]",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm",
    sortBy === col ? "text-text-secondary" : "",
  ].join(" ");

  // ─── Loading state ───────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col gap-1 p-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-3 px-3 py-2 rounded-lg animate-pulse"
            >
              <div className="w-4 h-4 rounded bg-bg-subtle shrink-0" />
              <div className="h-3 rounded bg-bg-subtle" style={{ width: `${40 + (i % 5) * 12}%` }} />
              <div className="ml-auto flex gap-8">
                <div className="w-12 h-3 rounded bg-bg-subtle" />
                <div className="w-16 h-3 rounded bg-bg-subtle" />
                <div className="w-16 h-3 rounded bg-bg-subtle" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      <div
        ref={tableRef}
        className="flex-1 overflow-y-auto"
        onClick={(e) => {
          const target = e.target as Element;
          if (!target.closest("[data-entry-row]")) setSelectedIds(new Set());
        }}
        onContextMenu={(e) => {
          const target = e.target as Element;
          if (!target.closest("[data-entry-row]")) {
            setSelectedIds(new Set());
            handleContextMenu(e, null);
          }
        }}
      >
        {/* Table header */}
        <div className="sticky top-0 z-10 bg-bg-surface border-b border-border px-3 py-2 flex items-center gap-2">
          <span className="w-5 shrink-0" />

          <button
            className={`flex-1 ${thClass("name")}`}
            onClick={() => handleSortClick("name")}
            aria-sort={sortBy === "name" ? (sortAsc ? "ascending" : "descending") : "none"}
          >
            Name <SortIcon col="name" />
          </button>

          <button
            className={`w-20 text-right ${thClass("size")}`}
            onClick={() => handleSortClick("size")}
            aria-sort={sortBy === "size" ? (sortAsc ? "ascending" : "descending") : "none"}
          >
            Size <SortIcon col="size" />
          </button>

          <button
            className={`w-32 ${thClass("modified")}`}
            onClick={() => handleSortClick("modified")}
            aria-sort={sortBy === "modified" ? (sortAsc ? "ascending" : "descending") : "none"}
          >
            Modified <SortIcon col="modified" />
          </button>

          {/* Last column: Permissions for SFTP, Class for S3 */}
          <span className="w-24 text-[length:var(--text-xs)] font-semibold uppercase tracking-wide text-text-muted select-none">
            {caps.hasPermissions ? "Permissions" : caps.hasStorageClass ? "Class" : ""}
          </span>
        </div>

        {/* New file/folder rows */}
        {creatingFile && (
          <NewFileRow
            onCommit={(name) => onCreateFile?.(name)}
            onCancel={() => onCancelCreateFile?.()}
          />
        )}
        {creatingFolder && (
          <NewFolderRow
            onCommit={(name) => onCreateFolder?.(name)}
            onCancel={() => onCancelCreateFolder?.()}
          />
        )}

        {/* Rows */}
        {sortedEntries.length === 0 && !creatingFolder && !creatingFile ? (
          <div className="flex flex-col items-center justify-center flex-1 min-h-[200px] gap-3 py-12">
            <Folder size={28} strokeWidth={1.2} className="text-text-muted/30" aria-hidden="true" />
            <p className="text-[length:var(--text-sm)] text-text-muted">
              This folder is empty
            </p>
            <div className="flex items-center gap-2">
              {caps.canCreateFile && (
                <button
                  onClick={() => document.dispatchEvent(new CustomEvent("explorer:new-file"))}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[length:var(--text-xs)] font-medium text-text-muted hover:text-text-secondary hover:bg-bg-subtle transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <FilePlus size={12} strokeWidth={2} aria-hidden="true" />
                  New File
                </button>
              )}
              {caps.canCreateFolder && (
                <button
                  onClick={() => document.dispatchEvent(new CustomEvent("explorer:new-folder"))}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[length:var(--text-xs)] font-medium text-text-muted hover:text-text-secondary hover:bg-bg-subtle transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <FolderPlus size={12} strokeWidth={2} aria-hidden="true" />
                  New Folder
                </button>
              )}
            </div>
            <p className="text-[length:var(--text-2xs)] text-text-muted/60">
              Right-click for more options
            </p>
          </div>
        ) : (
          <div
            role="list"
            aria-label="Directory contents"
            onContextMenu={(e) => {
              const target = e.target as Element;
              if (!target.closest("[data-entry-row]")) handleContextMenu(e, null);
            }}
          >
            {sortedEntries.map((entry) => {
              const isSelected = selectedIds.has(entry.id);
              return (
                <div
                  key={entry.id}
                  role="listitem"
                  data-entry-row="true"
                  tabIndex={0}
                  onClick={(e) => handleRowClick(entry, e)}
                  onDoubleClick={() => handleDoubleClick(entry)}
                  onContextMenu={(e) => {
                    if (!selectedIds.has(entry.id)) setSelectedIds(new Set([entry.id]));
                    handleContextMenu(e, entry);
                  }}
                  onKeyDown={(e) => {
                    const isInput = (e.target as Element).tagName === "INPUT";
                    if (e.key === "Enter" && !isInput) handleDoubleClick(entry);
                    if ((e.key === "Delete" || e.key === "Backspace") && caps.canDelete && !isInput) {
                      if (selectedIds.size > 0) setConfirmDelete(selectedEntries);
                    }
                    if ((e.metaKey || e.ctrlKey) && e.key === "a") {
                      e.preventDefault();
                      setSelectedIds(new Set(sortedEntries.map((en) => en.id)));
                    }
                    if (caps.canCopyPaste) {
                      if ((e.metaKey || e.ctrlKey) && e.key === "c" && selectedIds.size > 0) {
                        e.preventDefault();
                        onSetClipboard({ entries: selectedEntries, operation: "copy", sourceSessionId: provider.sessionId });
                      }
                      if ((e.metaKey || e.ctrlKey) && e.key === "x" && selectedIds.size > 0) {
                        e.preventDefault();
                        onSetClipboard({ entries: selectedEntries, operation: "cut", sourceSessionId: provider.sessionId });
                      }
                      if ((e.metaKey || e.ctrlKey) && e.key === "v" && canPaste) {
                        e.preventDefault();
                        onPaste?.();
                      }
                    }
                  }}
                  // Internal drag-drop (move between folders)
                  draggable={caps.canInternalDragMove}
                  onDragStart={caps.canInternalDragMove ? (e) => {
                    const entriesToDrag = selectedIds.has(entry.id) && selectedIds.size > 1
                      ? selectedEntries : [entry];
                    draggedEntriesRef.current = entriesToDrag;
                    e.dataTransfer.effectAllowed = "copyMove";
                    e.dataTransfer.setData("text/plain", entriesToDrag.map((en) => en.name).join(", "));
                  } : undefined}
                  onDragEnd={caps.canInternalDragMove ? () => {
                    draggedEntriesRef.current = [];
                    setDragOverId(null);
                    dragEnterCountRef.current = 0;
                  } : undefined}
                  onDragOver={caps.canInternalDragMove && entry.entryType === "Directory" ? (e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
                  } : undefined}
                  onDragEnter={caps.canInternalDragMove && entry.entryType === "Directory" ? (e) => {
                    e.preventDefault();
                    dragEnterCountRef.current++;
                    setDragOverId(entry.id);
                  } : undefined}
                  onDragLeave={caps.canInternalDragMove && entry.entryType === "Directory" ? () => {
                    dragEnterCountRef.current--;
                    if (dragEnterCountRef.current <= 0) {
                      setDragOverId(null);
                      dragEnterCountRef.current = 0;
                    }
                  } : undefined}
                  onDrop={caps.canInternalDragMove && entry.entryType === "Directory" ? (e) => {
                    e.preventDefault();
                    setDragOverId(null);
                    dragEnterCountRef.current = 0;
                    const sources = draggedEntriesRef.current;
                    if (sources.length === 0) return;
                    const sourceIds = sources.map((s) => s.id);
                    if (sourceIds.includes(entry.id)) return;
                    if (sourceIds.some((p) => entry.id.startsWith(p + "/"))) return;
                    const handler = e.altKey ? onCopyEntries : onMoveEntries;
                    void handler?.(sourceIds, entry.id);
                    draggedEntriesRef.current = [];
                  } : undefined}
                  className={[
                    "flex items-center gap-2 px-3 py-2 cursor-default",
                    "transition-colors duration-[var(--duration-fast)]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    "group",
                    isSelected ? "bg-accent/10 text-text-primary" : "hover:bg-bg-subtle",
                    cutIds?.has(entry.id) ? "opacity-40" : "",
                    dragOverId === entry.id ? "ring-2 ring-accent bg-accent/10" : "",
                  ].join(" ")}
                >
                  {/* Icon */}
                  <span className="w-5 flex items-center justify-center shrink-0">
                    <EntryIcon entry={entry} />
                  </span>

                  {/* Name — possibly in rename mode */}
                  <span className="flex-1 min-w-0 text-[length:var(--text-sm)] text-text-primary truncate">
                    {caps.canRename && renamingId === entry.id && onRename ? (
                      <RenameRow
                        entry={entry}
                        onRename={onRename}
                        onDone={() => setRenamingId(null)}
                      />
                    ) : (
                      entry.name
                    )}
                  </span>

                  {/* Size */}
                  <span className="w-20 text-right text-[length:var(--text-sm)] text-text-muted shrink-0 tabular-nums">
                    {entry.entryType === "Directory" ? "—" : formatBytes(entry.size)}
                  </span>

                  {/* Modified */}
                  <span className="w-32 text-[length:var(--text-sm)] text-text-muted shrink-0">
                    {formatModified(entry.modified)}
                  </span>

                  {/* Permissions / Storage Class */}
                  <span className="w-24 font-mono text-[length:var(--text-xs)] text-text-muted shrink-0 tracking-tight">
                    {caps.hasPermissions
                      ? entry.permissionsDisplay ?? ""
                      : caps.hasStorageClass
                        ? entry.storageClass ?? "—"
                        : ""}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          items={buildMenuItems(contextMenu.entry)}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Delete confirmation dialog */}
      {confirmDelete && confirmDelete.length > 0 && (
        <DeleteConfirmDialog
          entries={confirmDelete}
          onConfirm={() => void handleDeleteEntries(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {/* Info dialog */}
      {infoEntry && (
        <FileInfoDialog
          entry={infoEntry}
          capabilities={caps}
          onClose={() => setInfoEntry(null)}
        />
      )}
    </>
  );
}

// ─── Delete confirm dialog ────────────────────────────────────────────────────

function DeleteConfirmDialog({
  entries,
  onConfirm,
  onCancel,
}: {
  entries: ExplorerEntry[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const count = entries.length;
  const isSingle = count === 1;
  const entry = entries[0];
  const hasDirs = entries.some((e) => e.entryType === "Directory");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="w-full max-w-sm mx-4 rounded-xl bg-bg-overlay border border-border p-6 shadow-[var(--shadow-lg)]">
        <h2 className="text-[length:var(--text-lg)] font-semibold text-text-primary mb-2">
          {isSingle
            ? `Delete ${entry.entryType === "Directory" ? "Directory" : "File"}`
            : `Delete ${count} items`}
        </h2>
        <p className="text-[length:var(--text-sm)] text-text-secondary mb-6">
          {isSingle ? (
            <>
              Are you sure you want to delete{" "}
              <span className="font-mono text-text-primary">{entry.name}</span>?
              {entry.entryType === "Directory" && (
                <> This will delete all contents inside the directory.</>
              )}
            </>
          ) : (
            <>
              Are you sure you want to delete {count} items?
              {hasDirs && <> Directories and all their contents will be removed.</>}
            </>
          )}
          <span className="block mt-1 text-status-error">This action cannot be undone.</span>
        </p>

        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-[length:var(--text-sm)] text-text-secondary hover:text-text-primary rounded-lg transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 text-[length:var(--text-sm)] font-medium text-white bg-status-error hover:opacity-90 rounded-lg transition-[opacity] duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {isSingle ? "Delete" : `Delete ${count} items`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── File info dialog ──────────────────────────────────────────────────────────

function FileInfoDialog({
  entry,
  capabilities,
  onClose,
}: {
  entry: ExplorerEntry;
  capabilities: import("../../types/explorer").ProviderCapabilities;
  onClose: () => void;
}) {
  const isDir = entry.entryType === "Directory";
  const modified = entry.modified !== null
    ? new Date(entry.modified * 1000).toLocaleString()
    : "—";
  const copyPath = () => void navigator.clipboard.writeText(entry.id);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const labelClass = "text-[length:var(--text-xs)] text-text-muted w-[76px] shrink-0";
  const valueClass = "text-[length:var(--text-xs)] text-text-primary truncate min-w-0 flex-1";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg-base/60 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-label={`Info for ${entry.name}`}
        className="w-full max-w-[320px] mx-4 rounded-xl bg-bg-overlay border border-border shadow-[var(--shadow-lg)] animate-[fadeIn_120ms_var(--ease-expo-out)_both]"
      >
        <div className="flex items-center gap-2 px-4 pt-4 pb-3">
          <h2 className="text-[length:var(--text-sm)] font-semibold text-text-primary truncate flex-1" title={entry.name}>
            {entry.name}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex items-center justify-center w-6 h-6 rounded-md shrink-0 text-text-muted hover:text-text-primary hover:bg-bg-subtle transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X size={13} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>

        <div className="flex flex-col gap-0 px-4 pb-4">
          {!isDir && (
            <div className="flex items-baseline gap-3 py-1.5">
              <span className={labelClass}>Size</span>
              <span className={valueClass}>{formatBytes(entry.size)}</span>
            </div>
          )}

          <div className="flex items-baseline gap-3 py-1.5">
            <span className={labelClass}>Path</span>
            <span className={`${valueClass} font-mono text-[length:var(--text-2xs)]`} title={entry.id}>{entry.id}</span>
            <button
              onClick={copyPath}
              title="Copy path"
              aria-label="Copy path"
              className="shrink-0 p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-subtle transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Copy size={11} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>

          <div className="flex items-baseline gap-3 py-1.5">
            <span className={labelClass}>Modified</span>
            <span className={valueClass}>{modified}</span>
          </div>

          {capabilities.hasPermissions && entry.permissionsDisplay && (
            <div className="flex items-baseline gap-3 py-1.5">
              <span className={labelClass}>Permissions</span>
              <span className={`${valueClass} font-mono text-[length:var(--text-2xs)]`}>{entry.permissionsDisplay}</span>
            </div>
          )}

          {capabilities.hasStorageClass && entry.storageClass && (
            <div className="flex items-baseline gap-3 py-1.5">
              <span className={labelClass}>Class</span>
              <span className={valueClass}>{entry.storageClass}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
