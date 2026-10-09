import {
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useCallback,
} from "react";
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
  ArrowRightLeft,
  CornerLeftUp,
} from "lucide-react";
import { ModalShell, BTN_GHOST, BTN_DANGER } from "../shared/ModalShell";
import type {
  ExplorerEntry,
  ExplorerClipboard,
  FileSystemProvider,
  ChmodResult,
  CrossPaneTarget,
} from "../../types/explorer";
import { ContextMenu } from "../shared/ContextMenu";
import type { ContextMenuItem } from "../shared/ContextMenu";
import { formatBytes } from "../../utils/format";
import {
  useSettingsStore,
  type EditorConfig,
} from "../../stores/settings-store";
import { isEditableInEditor } from "../../lib/file-types";
import { closestAtPoint } from "../../lib/hit-test";
import { useDragStore } from "../../stores/drag-store";
import { FilePropertiesDialog } from "./FilePropertiesDialog";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExplorerFileTableProps {
  provider: FileSystemProvider;
  entries: ExplorerEntry[];
  sortBy: "name" | "size" | "modified";
  sortAsc: boolean;
  onSortChange: (
    sortBy: "name" | "size" | "modified",
    sortAsc: boolean,
  ) => void;
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
  /** Sibling pane in the dual-pane layout, enabling "Copy to <sibling>". Absent
   *  in single-pane mode and for the S3 pane. */
  crossPane?: CrossPaneTarget;
  /** Current directory path/prefix. Used to reset scroll on navigation while
   *  preserving it across same-directory refreshes (e.g. after a chmod). */
  currentPath?: string;
  loading?: boolean;
  busy?: boolean;
  /** This pane is one of a split (dual-pane). Splits stay compact — short date
   *  only — since space is tight and the filename matters most; a single pane
   *  can expand to the full date+time when wide. */
  dense?: boolean;
}

interface ContextMenuState {
  entry: ExplorerEntry | null;
  x: number;
  y: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Fixed-width timestamp so rows never wrap: zero-pad day/hour, and format the
// date and time separately to drop the locale's "at" joiner. `undefined` locale
// keeps month/day order and 12h/24h OS-aware. Formatters are hoisted — each
// toLocale* call constructs an Intl.DateTimeFormat, and this runs twice per
// row (title + text) on every render of large directories.
const MODIFIED_DATE_FMT = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "2-digit",
});
const MODIFIED_TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});
function formatModified(unix: number | null): string {
  if (unix === null) return "—";
  const date = new Date(unix * 1000);
  return `${MODIFIED_DATE_FMT.format(date)} ${MODIFIED_TIME_FMT.format(date)}`;
}

// Compact, date-only timestamp for narrow panes (drops the time). `dateStyle:
// "short"` yields the system locale's own canonical short date — e.g. 7/26/26
// (en-US), 26.07.26 (de-DE), 2026/07/26 (ja-JP).
const MODIFIED_SHORT_FMT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
});
function formatModifiedShort(unix: number | null): string {
  if (unix === null) return "—";
  return MODIFIED_SHORT_FMT.format(new Date(unix * 1000));
}

/** Compact octal mode for narrow panes, e.g. 0o644 → "644", 0o4755 → "4755". */
function octalMode(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(3, "0");
}

// Responsive column classes (each pane is its own @container). Name flexes with
// a 7rem minimum; the others are fixed-width and SNAP show/hide at thresholds set
// so a column only appears once there's room for it plus Name's minimum (no
// overflow/scroll). Narrowing drops Mode first, then Date. Header and body share
// these so columns stay aligned.
// Sentinel selection id for the pinned ".." row, so single-click selects it
// (visual feedback, like every other row) without it being a real entry —
// `selectedEntries` filters against the listing, so this never leaks into
// copy/cut/delete/download.
const UP_ROW_ID = "\u0000parent";

const COL_NAME = "flex-1 min-w-[7rem] truncate";
const COL_MODIFIED = "hidden @sm:block w-20 shrink-0";
const COL_PERMS = "hidden @md:block w-16 @2xl:w-28 shrink-0";

/** Owner-execute bit — the "is this runnable" signal, shown as a +x badge on
 *  files in the compact octal view (directories always have it, so it's noise
 *  there). */
function isExecutableFile(entry: ExplorerEntry): boolean {
  return (
    entry.entryType === "File" &&
    entry.permissions != null &&
    (entry.permissions & 0o100) !== 0
  );
}

function EntryIcon({ entry }: { entry: ExplorerEntry }) {
  if (entry.isSymlink) {
    return (
      <LinkIcon
        size={16}
        strokeWidth={1.8}
        className="text-accent shrink-0"
        aria-hidden="true"
      />
    );
  }
  switch (entry.entryType) {
    case "Directory":
      return (
        <Folder
          size={16}
          strokeWidth={1.8}
          className="text-accent shrink-0"
          aria-hidden="true"
        />
      );
    case "File":
      return (
        <FileText
          size={16}
          strokeWidth={1.6}
          className="text-text-muted shrink-0"
          aria-hidden="true"
        />
      );
    default:
      return (
        <File
          size={16}
          strokeWidth={1.6}
          className="text-text-muted shrink-0"
          aria-hidden="true"
        />
      );
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
  colDate,
  colPerms,
}: {
  onCommit: (name: string) => void;
  onCancel: () => void;
  // The size/date/perms column classes so the input row's trailing spacers line
  // up with the listing below it (date/perms are hidden at narrow widths).
  colDate: string;
  colPerms: string;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const commit = () => {
    const name = value.trim();
    if (name) onCommit(name);
    else onCancel();
  };

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-accent/5">
      <span className="w-5 flex items-center justify-center shrink-0">
        <Folder
          size={16}
          strokeWidth={1.8}
          className="text-accent"
          aria-hidden="true"
        />
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
      <span className="w-20 shrink-0" />
      <span className={colDate} />
      <span className={colPerms} />
    </div>
  );
}

function NewFileRow({
  onCommit,
  onCancel,
  colDate,
  colPerms,
}: {
  onCommit: (name: string) => void;
  onCancel: () => void;
  // See NewFolderRow: keep the trailing spacers aligned with the listing columns.
  colDate: string;
  colPerms: string;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const commit = () => {
    const name = value.trim();
    if (name) onCommit(name);
    else onCancel();
  };

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-accent/5">
      <span className="w-5 flex items-center justify-center shrink-0">
        <FileText
          size={16}
          strokeWidth={1.6}
          className="text-text-muted"
          aria-hidden="true"
        />
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
      <span className="w-20 shrink-0" />
      <span className={colDate} />
      <span className={colPerms} />
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
  crossPane,
  currentPath,
  loading,
  dense,
}: ExplorerFileTableProps) {
  // Date column: split panes stay short; a single pane grows to the full
  // date+time at ≥48rem (where Name still dominates). The header label and the
  // body text switch at the same @3xl breakpoint.
  const colDate = dense
    ? COL_MODIFIED
    : `${COL_MODIFIED} @3xl:w-52`;
  // Like the date: a dense (dual) pane stays on the short "Mode"/"Cls" form and
  // narrow width by default — no need to drag the split narrower — while a
  // single/zoomed pane keeps the width-driven "Permissions"/"Class".
  const colPerms = dense ? "hidden @md:block w-16 shrink-0" : COL_PERMS;
  const caps = provider.capabilities;
  const editors = useSettingsStore((s) => s.editors);
  const defaultEditorId = useSettingsStore((s) => s.defaultEditorId);
  const doubleClickAction = useSettingsStore(
    (s) => s.explorerDoubleClickAction,
  );
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ExplorerEntry[] | null>(
    null,
  );
  const [propsEntry, setPropsEntry] = useState<ExplorerEntry | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastClickedId = useRef<string | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  // Drag-and-drop state (internal move). The OS-level Tauri drag-drop handler is
  // enabled (for file-drop uploads), which suppresses HTML5 drag events in the
  // webview — so internal move/copy is driven by pointer events, not `draggable`.
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  // Highlight driven by a cross-pane drag happening in the OTHER pane: it targets
  // a folder/".." in THIS pane, so we light that row up too. Only this pane's rows
  // re-render (the selector returns null unless we're the drag's target pane).
  const crossDragTargetId = useDragStore((s) =>
    s.target?.paneKey === provider.sessionId ? s.target.entryId : null,
  );
  const [dragGhost, setDragGhost] = useState<{
    x: number;
    y: number;
    count: number;
    copy: boolean;
    /** Cursor is over the sibling pane (a cross-pane transfer, not an in-pane
     *  move) — changes the ghost label to name the destination. */
    cross: boolean;
  } | null>(null);

  // Reset scroll to the top only when the directory actually changes. Same-dir
  // refreshes (e.g. after a chmod / rename / create) keep the scroll container
  // mounted — see the skeleton guard below — so the position is preserved.
  useLayoutEffect(() => {
    if (tableRef.current) tableRef.current.scrollTop = 0;
  }, [currentPath]);

  // Cut entry dimming
  const cutIds =
    clipboard?.operation === "cut" &&
    clipboard.sourceSessionId === provider.sessionId
      ? new Set(clipboard.entries.map((e) => e.id))
      : null;

  // ─── Sort ─────────────────────────────────────────────────────────────────

  const sortedEntries = useMemo(
    () =>
      [...entries].sort((a, b) => {
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
      }),
    [entries, sortBy, sortAsc],
  );

  // Keyboard navigation walks this on every arrow keydown — derive it once per
  // sort change instead of rebuilding a fresh array per keypress.
  const sortedIds = useMemo(() => sortedEntries.map((en) => en.id), [sortedEntries]);

  // Pinned ".." row: the collapsed path bar makes "go up" hard to reach, so
  // offer the file-manager staple. Shown whenever a parent exists — at the root
  // `parentPath` returns the path unchanged, so this is false there.
  const parentDir = currentPath != null ? provider.parentPath(currentPath) : null;
  const showUpRow = parentDir != null && parentDir !== currentPath;

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
    (
      window as unknown as {
        __e2eExplorerStartRename?: (n: string, newName?: string) => void;
      }
    ).__e2eExplorerStartRename = hook;
    return () => {
      (
        window as unknown as {
          __e2eExplorerStartRename?:
            | ((n: string, newName?: string) => void)
            | null;
        }
      ).__e2eExplorerStartRename = null;
    };
  }, [sortedEntries, onRename]);

  // E2E test hook — apply chmod permission bits to an entry by name. Drives
  // the same onApplyPermissions path the Properties dialog "Apply" uses, but
  // bypasses the dialog UI (checkbox + octal-input interplay is awkward to
  // drive reliably in WebDriver). `mode` is the octal value as a number.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hook = (
      name: string,
      mode: number,
      recursive = false,
    ): Promise<ChmodResult | void> | undefined => {
      const entry = sortedEntries.find((e) => e.name === name);
      if (!entry || !onApplyPermissions) return undefined;
      return onApplyPermissions(entry, mode, recursive);
    };
    (
      window as unknown as {
        __e2eExplorerChmod?: (
          n: string,
          mode: number,
          recursive?: boolean,
        ) => Promise<ChmodResult | void> | undefined;
      }
    ).__e2eExplorerChmod = hook;
    return () => {
      (
        window as unknown as {
          __e2eExplorerChmod?:
            | ((
                n: string,
                mode: number,
                recursive?: boolean,
              ) => Promise<ChmodResult | void> | undefined)
            | null;
        }
      ).__e2eExplorerChmod = null;
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
    (
      window as unknown as {
        __e2eExplorerSetSelection?: (names: string[]) => void;
      }
    ).__e2eExplorerSetSelection = hook;
    return () => {
      (
        window as unknown as {
          __e2eExplorerSetSelection?: ((names: string[]) => void) | null;
        }
      ).__e2eExplorerSetSelection = null;
    };
  }, [sortedEntries]);

  // ─── Selection ───────────────────────────────────────────────────────────

  const handleRowClick = (entry: ExplorerEntry, e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(entry.id)) next.delete(entry.id);
        else next.add(entry.id);
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
        selectedIds.has(entry.id) && selectedIds.size > 1
          ? selectedEntries
          : [entry];
      const startX = e.clientX;
      const startY = e.clientY;
      let started = false;
      let moving = false;
      // Tracks whether the cursor is currently over the sibling pane, so the
      // ⌥-key handler (which has no pointer position) keeps the ghost on "copy"
      // there — a cross-pane drop is always a transfer, never a move.
      let overSibling = false;

      // Resolve the directory row under a point to a valid drop target id, or
      // null (not a dir, or dropping onto self / into the dragged subtree).
      const folderTargetAt = (x: number, y: number): string | null => {
        const row = closestAtPoint(x, y, "[data-entry-row]");
        if (!row) return null;
        // Dropping onto the pinned ".." row moves/copies into the parent dir.
        if (row.dataset.entryUp) return parentDir;
        if (row.dataset.entryType !== "Directory") return null;
        const target = entries.find(
          (en) =>
            en.name === row.dataset.entryName && en.entryType === "Directory",
        );
        if (!target) return null;
        const ids = dragEntries.map((s) => s.id);
        if (
          ids.includes(target.id) ||
          ids.some((p) => target.id.startsWith(p + "/"))
        )
          return null;
        return target.id;
      };

      // Whether (x,y) is over the sibling pane — the cross-pane transfer drop
      // zone. A drop there copies the selection into the other pane's cwd via
      // the coordinator (local→remote upload, remote→local download).
      const overSiblingPane = (x: number, y: number): boolean => {
        if (!crossPane) return false;
        const paneEl = closestAtPoint(x, y, "[data-explorer-pane-key]");
        return !!paneEl && paneEl.dataset.explorerPaneKey !== provider.sessionId;
      };

      // The folder/".." under the cursor in the SIBLING pane, as a destination dir
      // (its data-entry-id) — so a cross-pane drop lands INSIDE that folder, not
      // just the sibling's cwd. undefined = no folder under cursor → sibling cwd.
      const siblingTargetDirAt = (x: number, y: number): string | undefined => {
        const row = closestAtPoint(x, y, "[data-entry-row]");
        if (!row) return undefined;
        if (row.dataset.entryUp || row.dataset.entryType === "Directory") {
          // Return the id verbatim (not `|| undefined`): the S3 bucket root is the
          // EMPTY prefix "", a valid target — treating "" as "no target" would
          // send an S3 ".." drop to the current dir instead of the root.
          return row.dataset.entryId;
        }
        return undefined;
      };
      // Paint the sibling pane's hovered folder via the shared drag store (its
      // own component owns the highlight; we can't reach its local state).
      const paintSibling = (x: number, y: number): void => {
        const paneEl = closestAtPoint(x, y, "[data-explorer-pane-key]");
        const key = paneEl?.dataset.explorerPaneKey;
        const dir = siblingTargetDirAt(x, y);
        // dir can be "" (S3 root) — test for undefined, not falsy.
        useDragStore.getState().setTarget(key && dir !== undefined ? { paneKey: key, entryId: dir } : null);
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
          overSibling = overSiblingPane(ev.clientX, ev.clientY);
          if (overSibling) {
            setDragOverId(null);
            paintSibling(ev.clientX, ev.clientY);
          } else {
            useDragStore.getState().setTarget(null);
            setDragOverId(folderTargetAt(ev.clientX, ev.clientY));
          }
          setDragGhost({
            x: ev.clientX,
            y: ev.clientY,
            count: dragEntries.length,
            // Cross-pane: plain drop = copy, ⌥ = move. In-pane: plain = move,
            // ⌥ = copy. So the sense of ⌥ flips depending on where you are.
            copy: overSibling ? !ev.altKey : ev.altKey,
            cross: overSibling,
          });
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
        if (moving)
          setDragGhost((g) => (g ? { ...g, copy: overSibling ? !ev.altKey : ev.altKey } : g));
      };

      const onUp = (ev: PointerEvent) => {
        if (moving) {
          if (overSiblingPane(ev.clientX, ev.clientY)) {
            // Dropped on the other pane → transfer across, into the folder/".."
            // under the cursor if any (else the sibling's cwd). ⌥ makes it a move
            // (source deleted once the transfer lands); plain drop copies.
            const dir = siblingTargetDirAt(ev.clientX, ev.clientY);
            if (ev.altKey) crossPane?.moveTo(dragEntries, dir);
            else crossPane?.copyTo(dragEntries, dir);
          } else {
            const targetId = folderTargetAt(ev.clientX, ev.clientY);
            if (targetId) {
              const handler = ev.altKey ? onCopyEntries : onMoveEntries;
              void handler?.(
                dragEntries.map((s) => s.id),
                targetId,
              );
            }
          }
        }
        teardown();
      };

      // A cancelled pointer stream (OS/browser interruption) never fires
      // pointerup — tear down without performing a drop so listeners, the ghost,
      // and the sibling highlight don't leak.
      const onCancel = () => teardown();

      function teardown() {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey);
        window.removeEventListener("keyup", onKey);
        document.removeEventListener("mouseleave", onWindowLeave);
        setDragOverId(null);
        useDragStore.getState().setTarget(null);
        setDragGhost(null);
      }

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey);
      window.addEventListener("keyup", onKey);
      document.addEventListener("mouseleave", onWindowLeave);
    },
    [
      caps.canInternalDragMove,
      onDragOut,
      onMoveEntries,
      onCopyEntries,
      crossPane,
      parentDir,
      provider.sessionId,
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
    const defaultEditor =
      editors.find((e) => e.id === defaultEditorId) ?? editors[0];
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

  const handleContextMenu = (
    e: React.MouseEvent,
    entry: ExplorerEntry | null,
  ) => {
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

  // Paste is offered when this pane holds its own copy/cut, OR when the sibling
  // pane holds the most-recent cross-pane copy. The sibling case reads a ref, so
  // it's a fresh call at menu-open / keypress time rather than reactive state.
  const canPaste = () =>
    (caps.canCopyPaste &&
      clipboard !== null &&
      clipboard.sourceSessionId === provider.sessionId) ||
    (crossPane?.hasSiblingClipboard() ?? false);

  // Copy / cut / paste / select-all shortcuts, shared by the row handler (fires
  // when a row is focused) and the scroll-container handler (fires when the pane
  // is focused with no row — e.g. pasting into an empty target pane cross-pane).
  // Returns true when it consumed the event.
  const handleClipboardShortcut = (e: React.KeyboardEvent): boolean => {
    if (!(e.metaKey || e.ctrlKey)) return false;
    if ((e.target as Element).tagName === "INPUT") return false;
    if (e.key === "a") {
      e.preventDefault();
      setSelectedIds(new Set(sortedEntries.map((en) => en.id)));
      return true;
    }
    // Same-pane copy/paste needs a provider that can copy/move; a cross-pane
    // sibling (crossPane) enables the clipboard for transfer even when it can't
    // (e.g. S3 — ⌘C/⌘X seed the shared clipboard, ⌘V pulls from the sibling).
    if (!caps.canCopyPaste && !crossPane) return false;
    if (e.key === "c" && selectedEntries.length > 0) {
      e.preventDefault();
      onSetClipboard({ entries: selectedEntries, operation: "copy", sourceSessionId: provider.sessionId });
      return true;
    }
    if (e.key === "x" && selectedEntries.length > 0) {
      e.preventDefault();
      onSetClipboard({ entries: selectedEntries, operation: "cut", sourceSessionId: provider.sessionId });
      return true;
    }
    if (e.key === "v" && canPaste()) {
      e.preventDefault();
      onPaste?.();
      return true;
    }
    return false;
  };

  // Open the inline new-file/new-folder row in THIS pane — the dispatch carries
  // the pane key so the row opens in the targeted pane.
  const startCreate = (kind: "file" | "folder") => {
    document.dispatchEvent(
      new CustomEvent(`explorer:new-${kind}`, {
        detail: { paneKey: provider.sessionId },
      }),
    );
  };

  const buildMenuItems = (entry: ExplorerEntry | null): ContextMenuItem[] => {
    if (!entry) {
      const items: ContextMenuItem[] = [];
      if (canPaste()) {
        items.push({
          label: "Paste",
          icon: ClipboardPaste,
          onClick: () => onPaste?.(),
        });
        items.push({
          label: "",
          onClick: () => {},
          separator: true,
          disabled: true,
        });
      }
      if (caps.canCreateFile) {
        items.push({
          label: "New File",
          icon: File,
          onClick: () => startCreate("file"),
        });
      }
      if (caps.canCreateFolder) {
        items.push({
          label: "New Folder",
          icon: FolderPlus,
          onClick: () => startCreate("folder"),
        });
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
      if (crossPane) {
        items.push({
          label: `Copy ${count} items to ${crossPane.siblingLabel}`,
          icon: ArrowRightLeft,
          onClick: () => crossPane.copyTo(selectedEntries),
        });
      }
      if (caps.canCopyPaste || crossPane) {
        items.push({
          label: `Copy ${count} items`,
          icon: Copy,
          onClick: () =>
            onSetClipboard({
              entries: selectedEntries,
              operation: "copy",
              sourceSessionId: provider.sessionId,
            }),
        });
        items.push({
          label: `Cut ${count} items`,
          icon: Scissors,
          onClick: () =>
            onSetClipboard({
              entries: selectedEntries,
              operation: "cut",
              sourceSessionId: provider.sessionId,
            }),
        });
        if (canPaste()) {
          items.push({
            label: "Paste",
            icon: ClipboardPaste,
            onClick: () => onPaste?.(),
          });
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
    if (
      caps.canEditInEditor &&
      entry.entryType !== "Directory" &&
      editors.length > 0
    ) {
      const defaultEditor =
        editors.find((e) => e.id === defaultEditorId) ?? editors[0];
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
        items.push({
          label: "Download",
          icon: Download,
          onClick: () => onDownload(entry),
        });
      } else if (provider.type === "sftp") {
        items.push({
          label: "Download Folder",
          icon: Download,
          onClick: () => onDownload(entry),
        });
      }
    }

    if (crossPane) {
      items.push({
        label: `Copy to ${crossPane.siblingLabel}`,
        icon: ArrowRightLeft,
        onClick: () => crossPane.copyTo([entry]),
      });
    }

    if (caps.canPresignUrl && entry.entryType === "File") {
      items.push({
        label: "Copy Presigned URL",
        icon: Link2,
        onClick: () => onPresignUrl?.(entry),
      });
    }

    if (caps.canRename) {
      items.push({
        label: "Rename",
        icon: Pencil,
        onClick: () => setRenamingId(entry.id),
      });
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
        onClick: () =>
          onSetClipboard({
            entries: [entry],
            operation: "copy",
            sourceSessionId: provider.sessionId,
          }),
      });
      items.push({
        label: "Cut",
        icon: Scissors,
        onClick: () =>
          onSetClipboard({
            entries: [entry],
            operation: "cut",
            sourceSessionId: provider.sessionId,
          }),
      });
      if (canPaste()) {
        items.push({
          label: "Paste",
          icon: ClipboardPaste,
          onClick: () => onPaste?.(),
        });
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
  const SortArrow = ({
    col,
    gap,
  }: {
    col: "name" | "size" | "modified" | null;
    gap: "ml-0.5" | "mr-0.5";
  }) => {
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

  const thClass = (col: "name" | "size" | "modified") =>
    [
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
              <div
                className="h-3 rounded bg-bg-subtle"
                style={{ width: `${40 + (i % 5) * 12}%` }}
              />
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
      <div className="shrink-0 bg-bg-surface border-b border-border flex items-center gap-2 h-9 pl-3 pr-[calc(0.75rem+var(--scrollbar-size))] whitespace-nowrap">
        <span className="w-5 shrink-0" />

        <button
          data-testid="explorer-sort-name"
          className={`${COL_NAME} text-left ${thClass("name")}`}
          onClick={() => handleSortClick("name")}
          aria-sort={
            sortBy === "name" ? (sortAsc ? "ascending" : "descending") : "none"
          }
        >
          Name <SortArrow col="name" gap="ml-0.5" />
        </button>

        <button
          data-testid="explorer-sort-size"
          className={`w-20 text-right whitespace-nowrap ${thClass("size")}`}
          onClick={() => handleSortClick("size")}
          aria-sort={
            sortBy === "size" ? (sortAsc ? "ascending" : "descending") : "none"
          }
        >
          <SortArrow col="size" gap="mr-0.5" /> Size
        </button>

        <button
          data-testid="explorer-sort-modified"
          className={`${colDate} truncate text-center ${thClass("modified")}`}
          onClick={() => handleSortClick("modified")}
          aria-sort={
            sortBy === "modified"
              ? sortAsc
                ? "ascending"
                : "descending"
              : "none"
          }
        >
          <SortArrow col="modified" gap="mr-0.5" />{" "}
          {dense ? (
            "Date"
          ) : (
            <>
              <span className="@3xl:hidden">Date</span>
              <span className="hidden @3xl:inline">Modified</span>
            </>
          )}{" "}
          <SortArrow col={null} gap="ml-0.5" />
        </button>

        {/* Last column: Permissions for SFTP, Class for S3 — minifies to "Mode"/
            "Cls" (octal) on narrow AND on dense (dual) panes; full form on a
            single/zoomed pane. */}
        <span className={`${colPerms} text-[length:var(--text-xs)] font-semibold uppercase tracking-wide text-text-muted select-none truncate`}>
          {dense ? (
            caps.hasPermissions ? "Mode" : caps.hasStorageClass ? "Cls" : ""
          ) : (
            <>
              <span className="@2xl:hidden">
                {caps.hasPermissions ? "Mode" : caps.hasStorageClass ? "Cls" : ""}
              </span>
              <span className="hidden @2xl:inline">
                {caps.hasPermissions ? "Permissions" : caps.hasStorageClass ? "Class" : ""}
              </span>
            </>
          )}
        </span>
      </div>

      <div
        ref={tableRef}
        // -scroll, not -auto: the header above reserves the scrollbar gutter,
        // so short listings would otherwise sit 6px left of their headers.
        className={`flex-1 overflow-y-scroll overflow-x-hidden outline-none${dragGhost ? " select-none" : ""}`}
        // Focusable so keyboard copy/cut/paste work when the pane has focus but
        // no row does — e.g. a cross-pane ⌘V into an empty target pane. Only act
        // on events targeting the container itself; row-focused events are
        // handled by the row (and would otherwise double-fire as they bubble).
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget) handleClipboardShortcut(e);
        }}
        onClick={(e) => {
          const target = e.target as Element;
          if (!target.closest("[data-entry-row]")) {
            setSelectedIds(new Set());
            e.currentTarget.focus();
          }
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
            colDate={colDate}
            colPerms={colPerms}
          />
        )}
        {creatingFolder && (
          <NewFolderRow
            onCommit={(name) => onCreateFolder?.(name)}
            onCancel={() => onCancelCreateFolder?.()}
            colDate={colDate}
            colPerms={colPerms}
          />
        )}

        {/* Rows — the ".." row (when not at root) is pinned above the listing so
            it's reachable even in an empty folder, where the empty-state hint
            still renders below it. */}
        {(showUpRow || sortedEntries.length > 0) && (
          <div
            role="list"
            aria-label="Directory contents"
            onContextMenu={(e) => {
              const target = e.target as Element;
              if (!target.closest("[data-entry-row]"))
                handleContextMenu(e, null);
            }}
          >
            {showUpRow && (
              <div
                role="listitem"
                data-entry-row="true"
                data-entry-up="true"
                data-entry-id={parentDir ?? ""}
                data-entry-type="Directory"
                tabIndex={0}
                aria-label="Parent directory"
                title="Go to parent directory"
                onClick={() => setSelectedIds(new Set([UP_ROW_ID]))}
                onDoubleClick={() => onNavigate(parentDir!)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onNavigate(parentDir!);
                  }
                }}
                className={[
                  "flex items-center gap-2 px-3 py-2 cursor-default select-none",
                  "transition-colors duration-[var(--duration-fast)]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                  dragOverId === parentDir || crossDragTargetId === parentDir
                    ? "ring-2 ring-accent bg-accent/10"
                    : selectedIds.has(UP_ROW_ID)
                      ? "bg-accent/10 text-text-primary"
                      : "hover:bg-bg-subtle",
                ].join(" ")}
              >
                <span className="w-5 flex items-center justify-center shrink-0">
                  <CornerLeftUp size={16} strokeWidth={1.8} className="text-text-muted shrink-0" aria-hidden="true" />
                </span>
                <span className={`${COL_NAME} text-[length:var(--text-sm)] text-text-muted`}>..</span>
              </div>
            )}
            {sortedEntries.map((entry) => {
              const isSelected = selectedIds.has(entry.id);
              return (
                <div
                  key={entry.id}
                  role="listitem"
                  data-entry-row="true"
                  data-entry-name={entry.name}
                  data-entry-id={entry.id}
                  data-entry-type={entry.entryType}
                  data-testid={`explorer-entry-${entry.name}`}
                  tabIndex={0}
                  onClick={(e) => handleRowClick(entry, e)}
                  onDoubleClick={() => handleDoubleClick(entry)}
                  onContextMenu={(e) => {
                    if (!selectedIds.has(entry.id))
                      setSelectedIds(new Set([entry.id]));
                    handleContextMenu(e, entry);
                  }}
                  onKeyDown={(e) => {
                    const isInput = (e.target as Element).tagName === "INPUT";
                    if (e.key === "Enter" && !isInput) handleDoubleClick(entry);
                    if (
                      (e.key === "ArrowDown" || e.key === "ArrowUp") &&
                      !isInput
                    ) {
                      e.preventDefault();
                      const ids = sortedIds;
                      const currentIdx = ids.indexOf(entry.id);
                      const direction = e.key === "ArrowDown" ? 1 : -1;
                      const nextIdx = Math.min(
                        Math.max(currentIdx + direction, 0),
                        ids.length - 1,
                      );
                      if (nextIdx === currentIdx) return;
                      const nextId = ids[nextIdx];

                      if (e.shiftKey) {
                        const anchorId = lastClickedId.current ?? entry.id;
                        lastClickedId.current = anchorId;
                        const anchorIdx = ids.indexOf(anchorId);
                        const from = Math.min(anchorIdx, nextIdx);
                        const to = Math.max(anchorIdx, nextIdx);
                        const range = new Set<string>();
                        for (let i = from; i <= to; i++) range.add(ids[i]);
                        setSelectedIds(range);
                      } else {
                        setSelectedIds(new Set([nextId]));
                        lastClickedId.current = nextId;
                      }

                      const currentRow = e.currentTarget as HTMLElement;
                      const nextRow = (
                        direction === 1
                          ? currentRow.nextElementSibling
                          : currentRow.previousElementSibling
                      ) as HTMLElement | null;
                      nextRow?.focus();
                      nextRow?.scrollIntoView({ block: "nearest" });
                    }
                    if (e.key === "F2" && caps.canRename && !isInput) {
                      e.preventDefault();
                      setRenamingId(entry.id);
                    }
                    if (
                      (e.key === "Delete" || e.key === "Backspace") &&
                      caps.canDelete &&
                      !isInput
                    ) {
                      if (selectedEntries.length > 0)
                        setConfirmDelete(selectedEntries);
                    }
                    handleClipboardShortcut(e);
                  }}
                  // Pointer-driven drag (HTML5 DnD is suppressed by the OS
                  // drag-drop handler). Drop on a folder = move (Alt = copy);
                  // drag out of the window = download. See handleRowPointerDown.
                  onPointerDown={
                    caps.canInternalDragMove || onDragOut
                      ? (e) => handleRowPointerDown(e, entry)
                      : undefined
                  }
                  className={[
                    "flex items-center gap-2 px-3 py-2 cursor-default",
                    "transition-colors duration-[var(--duration-fast)]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    "group",
                    isSelected
                      ? "bg-accent/10 text-text-primary"
                      : "hover:bg-bg-subtle",
                    cutIds?.has(entry.id) ? "opacity-40" : "",
                    dragOverId === entry.id || crossDragTargetId === entry.id
                      ? "ring-2 ring-accent bg-accent/10"
                      : "",
                  ].join(" ")}
                >
                  {/* Icon */}
                  <span className="w-5 flex items-center justify-center shrink-0">
                    <EntryIcon entry={entry} />
                  </span>

                  {/* Name — possibly in rename mode */}
                  <span className={`${COL_NAME} text-[length:var(--text-sm)] text-text-primary`}>
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
                    {entry.entryType === "Directory"
                      ? "—"
                      : formatBytes(entry.size)}
                  </span>

                  {/* Modified — centered so it doesn't crowd the right-aligned
                      Size on its left or leave dead space before Permissions;
                      12px because mono reads visually larger than the 14px sans.
                      Truncate + title as a safety net for wide locales (#109).
                      Narrow panes show a date-only short form, then hide it. */}
                  <span
                    className={`${colDate} text-center text-[length:var(--text-xs)] text-text-muted font-mono tracking-tight truncate`}
                    title={formatModified(entry.modified)}
                  >
                    {dense ? (
                      formatModifiedShort(entry.modified)
                    ) : (
                      <>
                        <span className="@3xl:hidden">{formatModifiedShort(entry.modified)}</span>
                        <span className="hidden @3xl:inline">{formatModified(entry.modified)}</span>
                      </>
                    )}
                  </span>

                  {/* Permissions / Storage Class — narrow panes collapse the rwx
                      string to octal (e.g. drwxr-xr-x → 755). */}
                  <span
                    data-entry-perms={
                      caps.hasPermissions
                        ? (entry.permissionsDisplay ?? "")
                        : undefined
                    }
                    title={
                      caps.hasPermissions
                        ? (entry.permissionsDisplay ?? undefined)
                        : undefined
                    }
                    className={`${colPerms} font-mono text-[length:var(--text-xs)] text-text-muted tracking-tight truncate`}
                  >
                    {caps.hasPermissions ? (
                      (() => {
                        const octal = (
                          <>
                            {entry.permissions ? octalMode(entry.permissions) : ""}
                            {isExecutableFile(entry) && (
                              <span className="ml-0.5 text-accent font-semibold">+x</span>
                            )}
                          </>
                        );
                        return dense ? (
                          octal
                        ) : (
                          <>
                            <span className="@2xl:hidden">{octal}</span>
                            <span className="hidden @2xl:inline">
                              {entry.permissionsDisplay ?? ""}
                            </span>
                          </>
                        );
                      })()
                    ) : caps.hasStorageClass ? (
                      (entry.storageClass ?? "—")
                    ) : (
                      ""
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {sortedEntries.length === 0 && !creatingFolder && !creatingFile && (
          <div className="flex flex-col items-center justify-center min-h-[200px] gap-3 py-12">
            <Folder
              size={30}
              strokeWidth={1.2}
              className="text-text-muted/30"
              aria-hidden="true"
            />
            <p className="text-[length:var(--text-sm)] text-text-muted">
              This folder is empty
            </p>
            <div className="flex items-center gap-2">
              {caps.canCreateFile && (
                <button
                  onClick={() => startCreate("file")}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[length:var(--text-xs)] font-medium text-text-muted hover:text-text-secondary hover:bg-bg-subtle transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <FilePlus size={13} strokeWidth={2} aria-hidden="true" />
                  New File
                </button>
              )}
              {caps.canCreateFolder && (
                <button
                  onClick={() => startCreate("folder")}
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

      {/* Drag ghost for the pointer-driven move/copy. In-pane shows the ⌥=copy
          hint; over the sibling pane it names the destination (⌥ there = move). */}
      {dragGhost && (
        <div
          className="fixed z-50 pointer-events-none rounded-md bg-accent px-2 py-1 text-[length:var(--text-2xs)] font-medium text-white shadow-[var(--shadow-md)]"
          style={{ left: dragGhost.x + 12, top: dragGhost.y + 8 }}
        >
          {(() => {
            const n = dragGhost.count;
            const items = `${n} ${n === 1 ? "item" : "items"}`;
            const verb = dragGhost.copy ? "Copy" : "Move";
            if (dragGhost.cross) return `${verb} ${items} to ${crossPane?.siblingLabel ?? "other pane"}`;
            return dragGhost.copy ? `Copy ${items}` : `Move ${items} · ⌥ to copy`;
          })()}
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
          <button
            autoFocus
            data-testid="explorer-delete-cancel"
            type="button"
            onClick={onCancel}
            className={BTN_GHOST}
          >
            Cancel
          </button>
          <button
            data-testid="explorer-delete-confirm-button"
            type="button"
            onClick={onConfirm}
            className={BTN_DANGER}
          >
            {isSingle ? "Delete" : `Delete ${count} items`}
          </button>
        </>
      }
    >
      <p className="text-[length:var(--text-sm)] text-text-secondary">
        {isSingle ? (
          <>
            <span className="font-mono text-text-primary">{entry.name}</span>{" "}
            will be permanently deleted.
            {entry.entryType === "Directory" && (
              <> All contents inside will also be removed.</>
            )}
          </>
        ) : (
          <>
            {count} items will be permanently deleted.
            {hasDirs && (
              <> Directories and all their contents will be removed.</>
            )}
          </>
        )}
      </p>
    </ModalShell>
  );
}
