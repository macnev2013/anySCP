import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
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
  Link2,
  AlertTriangle,
} from "lucide-react";
import { ModalShell, BTN_GHOST, BTN_DANGER } from "../shared/ModalShell";
import type { ExplorerEntry, ExplorerClipboard, FileSystemProvider, ChmodResult } from "../../types/explorer";
import { ContextMenu } from "../shared/ContextMenu";
import type { ContextMenuItem } from "../shared/ContextMenu";
import { formatBytes } from "../../utils/format";
import { useSettingsStore, type EditorConfig } from "../../stores/settings-store";
import { isEditableInEditor } from "../../lib/file-types";
import { FilePropertiesDialog } from "./FilePropertiesDialog";

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
  /** Download a multi-entry selection at once (into a chosen folder). Absent
   *  for providers without a batch-download path. */
  onDownloadMany?: (entries: ExplorerEntry[]) => void;
  onDelete: (entries: ExplorerEntry[]) => Promise<void>;
  onRename?: (entry: ExplorerEntry, newName: string) => Promise<void>;
  onEditInEditor?: (entry: ExplorerEntry, editor?: EditorConfig) => void;
  onPresignUrl?: (entry: ExplorerEntry) => void;
  /** Apply chmod permission bits. SFTP/SCP only; absent for S3 → the
   *  Properties dialog shows permissions read-only (or hides them). When
   *  `recursive` is true (directories only) returns a per-entry summary. */
  onApplyPermissions?: (
    entry: ExplorerEntry,
    mode: number,
    recursive: boolean,
  ) => Promise<ChmodResult | void>;
  creatingFile?: boolean;
  onCreateFile?: (name: string) => void;
  onCancelCreateFile?: () => void;
  creatingFolder?: boolean;
  onCreateFolder?: (name: string) => void;
  onCancelCreateFolder?: () => void;
  onPaste?: () => void;
  onMoveEntries?: (sourceIds: string[], targetDir: string) => Promise<void>;
  onCopyEntries?: (sourceIds: string[], targetDir: string) => Promise<void>;
  /** Drag the selection out to the OS (download to desktop/Finder), files and
   *  folders alike. Triggered by a primary-modifier drag (⌘ on macOS, Ctrl
   *  elsewhere); a plain drag stays an in-app move. Absent for providers
   *  without OS drag-out support (e.g. SCP/S3). */
  onDragOut?: (entries: ExplorerEntry[]) => void;
  /** Current directory path/prefix. Used to reset scroll on navigation while
   *  preserving it across same-directory refreshes (e.g. after a chmod). */
  currentPath?: string;
  loading?: boolean;
  busy?: boolean;
}

interface ContextMenuState {
  entry: ExplorerEntry | null;
  x: number;
  y: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Fixed-width timestamp so rows never wrap: zero-pad day/hour, and format the
// date and time separately to drop the locale's "at" joiner. `undefined` locale
// keeps month/day order and 12h/24h OS-aware.
function formatModified(unix: number | null): string {
  if (unix === null) return "—";
  const date = new Date(unix * 1000);
  const day = date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${day} ${time}`;
}

function EntryIcon({ entry }: { entry: ExplorerEntry }) {
  if (entry.isSymlink) {
    return <LinkIcon size={16} strokeWidth={1.8} className="text-accent shrink-0" aria-hidden="true" />;
  }
  switch (entry.entryType) {
    case "Directory":
      return <Folder size={16} strokeWidth={1.8} className="text-accent shrink-0" aria-hidden="true" />;
    case "File":
      return <FileText size={16} strokeWidth={1.6} className="text-text-muted shrink-0" aria-hidden="true" />;
    default:
      return <File size={16} strokeWidth={1.6} className="text-text-muted shrink-0" aria-hidden="true" />;
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
      data-testid="explorer-rename-input"
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
        <Folder size={16} strokeWidth={1.8} className="text-accent" aria-hidden="true" />
      </span>
      <input
        ref={inputRef}
        data-testid="explorer-new-folder-input"
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
      <span className="w-44" />
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
        <FileText size={16} strokeWidth={1.6} className="text-text-muted" aria-hidden="true" />
      </span>
      <input
        ref={inputRef}
        data-testid="explorer-new-file-input"
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
      <span className="w-44" />
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
  onDownloadMany,
  onDelete,
  onRename,
  onEditInEditor,
  onPresignUrl,
  onApplyPermissions,
  creatingFolder,
  onCreateFolder,
  onCancelCreateFolder,
  creatingFile,
  onCreateFile,
  onCancelCreateFile,
  onPaste,
  onMoveEntries,
  onCopyEntries,
  onDragOut,
  currentPath,
  loading,
}: ExplorerFileTableProps) {
  const caps = provider.capabilities;
  const editors = useSettingsStore((s) => s.editors);
  const defaultEditorId = useSettingsStore((s) => s.defaultEditorId);
  const doubleClickAction = useSettingsStore((s) => s.explorerDoubleClickAction);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ExplorerEntry[] | null>(null);
  const [propsEntry, setPropsEntry] = useState<ExplorerEntry | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastClickedId = useRef<string | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  // Drag-and-drop state (internal move). The OS-level Tauri drag-drop handler is
  // enabled (for file-drop uploads), which suppresses HTML5 drag events in the
  // webview — so internal move/copy is driven by pointer events, not `draggable`.
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragGhost, setDragGhost] = useState<{ x: number; y: number; count: number; copy: boolean } | null>(null);

  // Reset scroll to the top only when the directory actually changes. Same-dir
  // refreshes (e.g. after a chmod / rename / create) keep the scroll container
  // mounted — see the skeleton guard below — so the position is preserved.
  useLayoutEffect(() => {
    if (tableRef.current) tableRef.current.scrollTop = 0;
  }, [currentPath]);

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

  // E2E test hook — drives rename programmatically. Two modes:
  //   - hook(name)          opens the inline rename input (UI flow)
  //   - hook(name, newName) calls onRename directly (bypasses the inline
  //                          input whose autoFocus + onBlur cancel races
  //                          with WebDriver's setValue). Exercises the
  //                          same backend invoke + listing update path.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hook = (name: string, newName?: string) => {
      const entry = sortedEntries.find((e) => e.name === name);
      if (!entry) return;
      if (newName != null && newName !== entry.name && onRename) {
        void onRename(entry, newName);
      } else {
        setRenamingId(entry.id);
      }
    };
    (window as unknown as {
      __e2eExplorerStartRename?: (n: string, newName?: string) => void;
    }).__e2eExplorerStartRename = hook;
    return () => {
      (window as unknown as {
        __e2eExplorerStartRename?: ((n: string, newName?: string) => void) | null;
      }).__e2eExplorerStartRename = null;
    };
  }, [sortedEntries, onRename]);

  // E2E test hook — apply chmod permission bits to an entry by name. Drives
  // the same onApplyPermissions path the Properties dialog "Apply" uses, but
  // bypasses the dialog UI (checkbox + octal-input interplay is awkward to
  // drive reliably in WebDriver). `mode` is the octal value as a number.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hook = (name: string, mode: number, recursive = false): Promise<ChmodResult | void> | undefined => {
      const entry = sortedEntries.find((e) => e.name === name);
      if (!entry || !onApplyPermissions) return undefined;
      return onApplyPermissions(entry, mode, recursive);
    };
    (window as unknown as {
      __e2eExplorerChmod?: (n: string, mode: number, recursive?: boolean) => Promise<ChmodResult | void> | undefined;
    }).__e2eExplorerChmod = hook;
    return () => {
      (window as unknown as {
        __e2eExplorerChmod?: ((n: string, mode: number, recursive?: boolean) => Promise<ChmodResult | void> | undefined) | null;
      }).__e2eExplorerChmod = null;
    };
  }, [sortedEntries, onApplyPermissions]);

  // E2E test hook — select a specific set of entries by name. Multi-select
  // via Ctrl-click is awkward to drive in WebDriver because the row needs
  // keyboard focus AND modifier-key chord handling at the same time.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hook = (names: string[]) => {
      const ids = new Set(
        names
          .map((n) => sortedEntries.find((e) => e.name === n)?.id)
          .filter((id): id is string => typeof id === "string"),
      );
      setSelectedIds(ids);
    };
    (window as unknown as {
      __e2eExplorerSetSelection?: (names: string[]) => void;
    }).__e2eExplorerSetSelection = hook;
    return () => {
      (window as unknown as {
        __e2eExplorerSetSelection?: ((names: string[]) => void) | null;
      }).__e2eExplorerSetSelection = null;
    };
  }, [sortedEntries]);

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

  // ─── Drag (pointer-based) ──────────────────────────────────────────────────
  //
  // HTML5 drag-and-drop doesn't fire in the webview while Tauri's OS drag-drop
  // handler is enabled (it is, for file-drop uploads), so all dragging is driven
  // by pointer events. The DESTINATION decides the action (no modifier keys):
  //   • drop on a folder row     → in-app move  (hold Alt while dropping = copy)
  //   • drag out of the window   → native OS download (drag-out to desktop)
  // The folder under the cursor is hit-tested with elementFromPoint; a plain
  // click never crosses the 5px threshold, so selection and double-click are
  // unaffected.
  const handleRowPointerDown = useCallback(
    (e: React.PointerEvent, entry: ExplorerEntry) => {
      if (e.button !== 0 || renamingId) return;
      if (!(caps.canInternalDragMove || onDragOut)) return;
      if ((e.target as HTMLElement).closest("input")) return;

      const dragEntries =
        selectedIds.has(entry.id) && selectedIds.size > 1 ? selectedEntries : [entry];
      const startX = e.clientX;
      const startY = e.clientY;
      let started = false;
      let moving = false;

      // Resolve the directory row under a point to a valid drop target id, or
      // null (not a dir, or dropping onto self / into the dragged subtree).
      const folderTargetAt = (x: number, y: number): string | null => {
        const row = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest(
          "[data-entry-row]",
        ) as HTMLElement | null;
        if (!row || row.dataset.entryType !== "Directory") return null;
        const target = entries.find(
          (en) => en.name === row.dataset.entryName && en.entryType === "Directory",
        );
        if (!target) return null;
        const ids = dragEntries.map((s) => s.id);
        if (ids.includes(target.id) || ids.some((p) => target.id.startsWith(p + "/"))) return null;
        return target.id;
      };

      // Hand off to the native OS download drag (only once).
      let handedOff = false;
      const dragOut = () => {
        if (handedOff || !onDragOut) return;
        handedOff = true;
        teardown();
        onDragOut(dragEntries);
      };

      const onMove = (ev: PointerEvent) => {
        if (!started) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
          started = true;
          // Providers that can't move in-app (none today) can only download.
          if (!caps.canInternalDragMove) {
            dragOut();
            return;
          }
          moving = true;
        }
        if (moving) {
          // Crossing the window edge = dragging toward the desktop/Finder →
          // download. Otherwise it's an in-app move/copy onto a folder row.
          if (
            onDragOut &&
            (ev.clientX <= 0 ||
              ev.clientY <= 0 ||
              ev.clientX >= window.innerWidth ||
              ev.clientY >= window.innerHeight)
          ) {
            dragOut();
            return;
          }
          setDragOverId(folderTargetAt(ev.clientX, ev.clientY));
          setDragGhost({ x: ev.clientX, y: ev.clientY, count: dragEntries.length, copy: ev.altKey });
        }
      };

      // Backstop for the edge check: fires when the cursor actually exits the
      // window (e.g. a fast drag onto the desktop that skips the boundary px).
      const onWindowLeave = () => {
        if (moving) dragOut();
      };

      // Reflect Alt (copy) the instant it's pressed/released, without waiting for
      // the next pointer move.
      const onKey = (ev: KeyboardEvent) => {
        if (moving) setDragGhost((g) => (g ? { ...g, copy: ev.altKey } : g));
      };

      const onUp = (ev: PointerEvent) => {
        if (moving) {
          const targetId = folderTargetAt(ev.clientX, ev.clientY);
          if (targetId) {
            const handler = ev.altKey ? onCopyEntries : onMoveEntries;
            void handler?.(
              dragEntries.map((s) => s.id),
              targetId,
            );
          }
        }
        teardown();
      };

      function teardown() {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("keydown", onKey);
        window.removeEventListener("keyup", onKey);
        document.removeEventListener("mouseleave", onWindowLeave);
        setDragOverId(null);
        setDragGhost(null);
      }

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("keydown", onKey);
      window.addEventListener("keyup", onKey);
      document.addEventListener("mouseleave", onWindowLeave);
    },
    [
      caps.canInternalDragMove,
      onDragOut,
      onMoveEntries,
      onCopyEntries,
      selectedIds,
      selectedEntries,
      entries,
      renamingId,
    ],
  );

  // ─── Row actions ──────────────────────────────────────────────────────────

  const handleDoubleClick = (entry: ExplorerEntry) => {
    if (entry.entryType === "Directory") {
      onNavigate(entry.id);
      return;
    }
    // For files, the action is configurable (Settings → Explorer). "Open in
    // editor" uses the default editor, but only for text-editable files —
    // binaries (video, images, PDFs, archives, …) fall back to download rather
    // than dumping raw bytes into the editor. It also falls back when editing
    // isn't possible (no editor configured, or the provider can't edit).
    const defaultEditor = editors.find((e) => e.id === defaultEditorId) ?? editors[0];
    if (
      doubleClickAction === "open" &&
      caps.canEditInEditor &&
      onEditInEditor &&
      defaultEditor &&
      isEditableInEditor(entry.name)
    ) {
      onEditInEditor(entry, defaultEditor);
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
      if (caps.canDownload && onDownloadMany) {
        items.push({
          label: `Download ${count} items`,
          icon: Download,
          onClick: () => onDownloadMany(selectedEntries),
        });
      }
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

    // Single item context menu. Only offered when at least one editor is
    // configured (auto-seeded on first run, or added in Settings → Editors).
    if (caps.canEditInEditor && entry.entryType !== "Directory" && editors.length > 0) {
      const defaultEditor = editors.find((e) => e.id === defaultEditorId) ?? editors[0];
      // Primary "Edit" uses the default editor.
      items.push({
        label: `Edit in ${defaultEditor.name}`,
        icon: ExternalLink,
        onClick: () => onEditInEditor?.(entry, defaultEditor),
      });
      // "Open With ▸" lists every configured editor (only worth showing when
      // there's a choice beyond the default).
      if (editors.length > 1) {
        items.push({
          label: "Open With",
          icon: ExternalLink,
          submenu: editors.map((ed) => ({
            label: ed.name,
            onClick: () => onEditInEditor?.(entry, ed),
          })),
        });
      }
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
        label: "Properties",
        icon: Info,
        separator: true,
        onClick: () => setPropsEntry(entry),
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

  // The chevron is always rendered (just `invisible` when inactive) so it
  // reserves a constant width and position — sorting never shifts the header. It
  // sits on the side away from the label's alignment edge; a centered label gets
  // a `col={null}` reserving-only copy on the far side to stay centered.
  const SortArrow = ({ col, gap }: { col: "name" | "size" | "modified" | null; gap: "ml-0.5" | "mr-0.5" }) => {
    const active = col !== null && sortBy === col;
    const Icon = active && !sortAsc ? ChevronDown : ChevronUp;
    return (
      <Icon
        size={12}
        strokeWidth={2.5}
        aria-hidden="true"
        className={`inline ${gap} ${active ? "" : "invisible"}`}
      />
    );
  };

  const thClass = (col: "name" | "size" | "modified") => [
    // No text-align here — each header sets its own (buttons default to center).
    // A hardcoded one would beat the columns' text-center in the CSS cascade.
    "text-[length:var(--text-xs)] font-semibold uppercase tracking-wide text-text-muted",
    "cursor-pointer select-none hover:text-text-secondary transition-colors duration-[var(--duration-fast)]",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm",
    sortBy === col ? "text-text-secondary" : "",
  ].join(" ");

  // ─── Loading state ───────────────────────────────────────────────────────
  // Only show the skeleton on a genuine first load (no entries yet). When
  // refreshing a directory that already has entries, keep the list mounted so
  // the scroll position survives (the toolbar shows a refresh spinner instead).

  if (loading && entries.length === 0) {
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
      {/* Column header — a fixed row above the list, a sibling of the scroller
          rather than a child, so the scroller stays a direct flex child of the
          pane column and scrolls. The right padding reserves the scrollbar
          gutter so the columns line up with the rows beneath. */}
      <div className="shrink-0 bg-bg-surface border-b border-border flex items-center gap-2 py-2 pl-3 pr-[calc(0.75rem+var(--scrollbar-size))]">
        <span className="w-5 shrink-0" />

        <button
          data-testid="explorer-sort-name"
          className={`flex-1 text-left ${thClass("name")}`}
          onClick={() => handleSortClick("name")}
          aria-sort={sortBy === "name" ? (sortAsc ? "ascending" : "descending") : "none"}
        >
          Name <SortArrow col="name" gap="ml-0.5" />
        </button>

        <button
          data-testid="explorer-sort-size"
          className={`w-20 text-right ${thClass("size")}`}
          onClick={() => handleSortClick("size")}
          aria-sort={sortBy === "size" ? (sortAsc ? "ascending" : "descending") : "none"}
        >
          <SortArrow col="size" gap="mr-0.5" /> Size
        </button>

        <button
          data-testid="explorer-sort-modified"
          className={`w-44 text-center ${thClass("modified")}`}
          onClick={() => handleSortClick("modified")}
          aria-sort={sortBy === "modified" ? (sortAsc ? "ascending" : "descending") : "none"}
        >
          <SortArrow col="modified" gap="mr-0.5" /> Modified <SortArrow col={null} gap="ml-0.5" />
        </button>

        {/* Last column: Permissions for SFTP, Class for S3 */}
        <span className="w-24 text-[length:var(--text-xs)] font-semibold uppercase tracking-wide text-text-muted select-none">
          {caps.hasPermissions ? "Permissions" : caps.hasStorageClass ? "Class" : ""}
        </span>
      </div>

      <div
        ref={tableRef}
        className={`flex-1 overflow-y-auto${dragGhost ? " select-none" : ""}`}
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
            <Folder size={30} strokeWidth={1.2} className="text-text-muted/30" aria-hidden="true" />
            <p className="text-[length:var(--text-sm)] text-text-muted">
              This folder is empty
            </p>
            <div className="flex items-center gap-2">
              {caps.canCreateFile && (
                <button
                  onClick={() => document.dispatchEvent(new CustomEvent("explorer:new-file"))}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[length:var(--text-xs)] font-medium text-text-muted hover:text-text-secondary hover:bg-bg-subtle transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <FilePlus size={13} strokeWidth={2} aria-hidden="true" />
                  New File
                </button>
              )}
              {caps.canCreateFolder && (
                <button
                  onClick={() => document.dispatchEvent(new CustomEvent("explorer:new-folder"))}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[length:var(--text-xs)] font-medium text-text-muted hover:text-text-secondary hover:bg-bg-subtle transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <FolderPlus size={13} strokeWidth={2} aria-hidden="true" />
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
                  data-entry-name={entry.name}
                  data-entry-type={entry.entryType}
                  data-testid={`explorer-entry-${entry.name}`}
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
                    if (e.key === "F2" && caps.canRename && !isInput) {
                      e.preventDefault();
                      setRenamingId(entry.id);
                    }
                    if ((e.key === "Delete" || e.key === "Backspace") && caps.canDelete && !isInput) {
                      if (selectedIds.size > 0) setConfirmDelete(selectedEntries);
                    }
                    if (!isInput && (e.metaKey || e.ctrlKey) && e.key === "a") {
                      e.preventDefault();
                      setSelectedIds(new Set(sortedEntries.map((en) => en.id)));
                    }
                    if (!isInput && caps.canCopyPaste) {
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
                  // Pointer-driven drag (HTML5 DnD is suppressed by the OS
                  // drag-drop handler). Drop on a folder = move (Alt = copy);
                  // drag out of the window = download. See handleRowPointerDown.
                  onPointerDown={(caps.canInternalDragMove || onDragOut)
                    ? (e) => handleRowPointerDown(e, entry)
                    : undefined}
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
                  <span className="w-20 text-right text-[length:var(--text-xs)] text-text-muted shrink-0 font-mono tabular-nums whitespace-nowrap">
                    {entry.entryType === "Directory" ? "—" : formatBytes(entry.size)}
                  </span>

                  {/* Modified — centered so it doesn't crowd the right-aligned
                      Size on its left or leave dead space before Permissions;
                      12px because mono reads visually larger than the 14px sans. */}
                  <span className="w-44 text-center text-[length:var(--text-xs)] text-text-muted shrink-0 font-mono tracking-tight whitespace-nowrap">
                    {formatModified(entry.modified)}
                  </span>

                  {/* Permissions / Storage Class */}
                  <span
                    data-entry-perms={caps.hasPermissions ? entry.permissionsDisplay ?? "" : undefined}
                    className="w-24 font-mono text-[length:var(--text-xs)] text-text-muted shrink-0 tracking-tight whitespace-nowrap"
                  >
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

      {/* Properties dialog */}
      {propsEntry && (
        <FilePropertiesDialog
          entry={propsEntry}
          capabilities={caps}
          onApplyPermissions={onApplyPermissions}
          onClose={() => setPropsEntry(null)}
        />
      )}

      {/* Drag ghost for the pointer-driven move/copy, with an Alt=copy hint. */}
      {dragGhost && (
        <div
          className="fixed z-50 pointer-events-none rounded-md bg-accent px-2 py-1 text-[length:var(--text-2xs)] font-medium text-white shadow-[var(--shadow-md)]"
          style={{ left: dragGhost.x + 12, top: dragGhost.y + 8 }}
        >
          {dragGhost.copy
            ? `Copy ${dragGhost.count} ${dragGhost.count === 1 ? "item" : "items"}`
            : `Move ${dragGhost.count} ${dragGhost.count === 1 ? "item" : "items"} · ⌥ to copy`}
        </div>
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

  const title = isSingle
    ? `Delete ${entry.entryType === "Directory" ? "Directory" : "File"}`
    : `Delete ${count} items`;

  return (
    <ModalShell
      open
      onClose={onCancel}
      title={title}
      icon={AlertTriangle}
      iconVariant="danger"
      maxWidth="sm"
      testId="explorer-delete-confirm"
      footer={
        <>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <button autoFocus data-testid="explorer-delete-cancel" type="button" onClick={onCancel} className={BTN_GHOST}>
            Cancel
          </button>
          <button data-testid="explorer-delete-confirm-button" type="button" onClick={onConfirm} className={BTN_DANGER}>
            {isSingle ? "Delete" : `Delete ${count} items`}
          </button>
        </>
      }
    >
      <p className="text-[length:var(--text-sm)] text-text-secondary">
        {isSingle ? (
          <>
            <span className="font-mono text-text-primary">{entry.name}</span> will be permanently deleted.
            {entry.entryType === "Directory" && <> All contents inside will also be removed.</>}
          </>
        ) : (
          <>
            {count} items will be permanently deleted.
            {hasDirs && <> Directories and all their contents will be removed.</>}
          </>
        )}
      </p>
    </ModalShell>
  );
}
