import { useState, useEffect, useMemo, useCallback } from "react";
import { X, Copy, Folder, FileText, Link as LinkIcon, Loader2, AlertCircle } from "lucide-react";
import type { ExplorerEntry, ProviderCapabilities, ChmodResult } from "../../types/explorer";
import { formatBytes } from "../../utils/format";
import {
  permissionsStringToOctal,
  octalToPermissionBits,
  permissionBitsToOctal,
  octalToString,
  octalToPermissionsString,
  sanitizeOctalInput,
  type PermissionBits,
} from "../../lib/permissions";

// ─── Props ──────────────────────────────────────────────────────────────────

interface FilePropertiesDialogProps {
  entry: ExplorerEntry;
  capabilities: ProviderCapabilities;
  /** Apply new permission bits (octal number). Absent → permissions are
   *  read-only (e.g. S3, or a transport that can't chmod). When `recursive`
   *  is true (directories only) returns a per-entry summary. */
  onApplyPermissions?: (
    entry: ExplorerEntry,
    mode: number,
    recursive: boolean,
  ) => Promise<ChmodResult | void>;
  onClose: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function locationOf(id: string): string {
  const idx = id.lastIndexOf("/");
  if (idx < 0) return "/";
  return idx === 0 ? "/" : id.slice(0, idx);
}

// Rows: Owner / Group / Other; columns: Read / Write / Execute.
const ROW_LABELS = ["Owner", "Group", "Other"] as const;
const COL_LABELS = ["Read", "Write", "Execute"] as const;
const ROW_KEYS: ReadonlyArray<ReadonlyArray<keyof PermissionBits>> = [
  ["ownerR", "ownerW", "ownerX"],
  ["groupR", "groupW", "groupX"],
  ["otherR", "otherW", "otherX"],
];

// ─── Component ────────────────────────────────────────────────────────────────

export function FilePropertiesDialog({
  entry,
  capabilities,
  onApplyPermissions,
  onClose,
}: FilePropertiesDialogProps) {
  const isDir = entry.entryType === "Directory";

  // Special permission bits (setuid/setgid/sticky) live in the raw mode but the
  // rwx editor only covers the lower 9 bits. Track them so a chmod preserves
  // them instead of silently stripping e.g. a setuid binary's bit.
  const specialBits = (entry.permissions ?? 0) & 0o7000;
  const specialBitsLabel = [
    specialBits & 0o4000 ? "setuid" : null,
    specialBits & 0o2000 ? "setgid" : null,
    specialBits & 0o1000 ? "sticky" : null,
  ]
    .filter(Boolean)
    .join(", ");

  // Initial octal derived from the rwx display string (SFTP only).
  const initialOctal = useMemo(
    () => (entry.permissionsDisplay ? permissionsStringToOctal(entry.permissionsDisplay) : 0),
    [entry.permissionsDisplay],
  );

  const [octal, setOctal] = useState(initialOctal);
  const [octalInput, setOctalInput] = useState(octalToString(initialOctal));
  const [recursive, setRecursive] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync local edit state when the entry's permissions change underneath us
  // (e.g. the parent refreshes the listing after a partial recursive chmod that
  // kept the dialog open). Without this, `octal` keeps its stale value and the
  // dirty/Apply state desyncs from what's shown. `initialOctal` is a number, so
  // this only fires when the mode actually changed, never on unrelated rerenders.
  useEffect(() => {
    setOctal(initialOctal);
    setOctalInput(octalToString(initialOctal));
  }, [initialOctal]);

  const bits = octalToPermissionBits(octal);

  // Symlink permissions describe the link itself, which is rarely meaningful to
  // change; keep them read-only. S3 has no permissions at all.
  const canEditPermissions =
    capabilities.hasPermissions && !entry.isSymlink && !!onApplyPermissions;
  const showPermissions = capabilities.hasPermissions;
  const dirty = octal !== initialOctal;
  // Recursive apply is meaningful even when the root's octal is unchanged
  // (propagating the existing mode down), so it enables Apply on its own.
  const canApply = canEditPermissions && (dirty || (recursive && isDir));

  // ─── Sync helpers ─────────────────────────────────────────────────────────

  const setOctalBoth = useCallback((next: number) => {
    const masked = next & 0o777;
    setOctal(masked);
    setOctalInput(octalToString(masked));
  }, []);

  const toggleBit = (key: keyof PermissionBits) => {
    if (!canEditPermissions) return;
    setOctalBoth(permissionBitsToOctal({ ...bits, [key]: !bits[key] }));
  };

  const handleOctalInput = (raw: string) => {
    // Keep the last 3 octal digits so the conventional leading-zero form pastes
    // correctly ("0755" → "755", not "075"). See `sanitizeOctalInput`.
    const cleaned = sanitizeOctalInput(raw);
    setOctalInput(cleaned);
    if (cleaned.length > 0) {
      setOctal(parseInt(cleaned, 8) & 0o777);
    } else {
      // Empty field means "no change specified": roll `octal` back to the
      // initial mode so Apply doesn't stay enabled with a stale, invisible value
      // (blur then re-normalises the text to the initial octal string).
      setOctal(initialOctal);
    }
  };

  const handleOctalBlur = () => {
    // Normalise to a 3-digit string on blur.
    setOctalInput(octalToString(octal));
  };

  // ─── Apply ────────────────────────────────────────────────────────────────

  const handleApply = useCallback(async () => {
    if (!onApplyPermissions || !canApply || applying) return;
    const isRecursive = recursive && isDir;
    setApplying(true);
    setError(null);
    try {
      // Preserve setuid/setgid/sticky for a single-file chmod (the rwx editor
      // only covers the lower 9 bits). A recursive apply deliberately sends just
      // those 9 bits, matching `chmod -R <octal>` — propagating the root's
      // special bits onto every descendant would be dangerous.
      const modeToApply = isRecursive ? octal : octal | specialBits;
      const result = await onApplyPermissions(entry, modeToApply, isRecursive);
      // Recursive apply collects per-entry failures instead of throwing. Show a
      // summary and keep the dialog open when some entries failed; otherwise
      // close as for a normal apply.
      if (result && result.errors.length > 0) {
        const appliedPart = result.applied > 0 ? ` to ${result.applied} item(s)` : "";
        setError(
          `Applied${appliedPart}, ${result.errors.length} error(s). ${result.errors[0]}`,
        );
      } else {
        onClose();
      }
    } catch (err) {
      const msg =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : err instanceof Error
            ? err.message
            : "Failed to change permissions";
      setError(msg);
    } finally {
      setApplying(false);
    }
  }, [onApplyPermissions, canApply, applying, recursive, isDir, entry, octal, specialBits, onClose]);

  // ─── Escape to close ──────────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !applying) onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, applying]);

  const copyPath = () => void navigator.clipboard.writeText(entry.id);

  const modified =
    entry.modified !== null ? new Date(entry.modified * 1000).toLocaleString() : "—";
  const location = locationOf(entry.id);

  const labelClass = "text-[length:var(--text-xs)] text-text-muted w-[76px] shrink-0";
  const valueClass = "text-[length:var(--text-xs)] text-text-primary truncate min-w-0 flex-1";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg-base/60 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && !applying && onClose()}
    >
      <div
        role="dialog"
        aria-label={`Properties for ${entry.name}`}
        data-testid="file-properties-dialog"
        className="w-full max-w-[380px] mx-4 rounded-xl bg-bg-overlay border border-border shadow-[var(--shadow-lg)] animate-[fadeIn_120ms_var(--ease-expo-out)_both]"
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 pt-4 pb-3 border-b border-border">
          {isDir ? (
            <Folder size={16} strokeWidth={1.8} className="text-accent shrink-0" aria-hidden="true" />
          ) : entry.isSymlink ? (
            <LinkIcon size={16} strokeWidth={1.8} className="text-accent shrink-0" aria-hidden="true" />
          ) : (
            <FileText size={16} strokeWidth={1.6} className="text-text-muted shrink-0" aria-hidden="true" />
          )}
          <h2
            className="text-[length:var(--text-sm)] font-semibold text-text-primary truncate flex-1"
            title={entry.name}
          >
            {entry.name}
          </h2>
          <button
            onClick={onClose}
            disabled={applying}
            aria-label="Close"
            className="flex items-center justify-center w-6 h-6 rounded-md shrink-0 text-text-muted hover:text-text-primary hover:bg-bg-subtle transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <X size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>

        {/* File info */}
        <div className="flex flex-col gap-0 px-4 py-3">
          <div className="flex items-baseline gap-3 py-1">
            <span className={labelClass}>Type</span>
            <span className={valueClass}>
              {entry.isSymlink ? "Symlink" : isDir ? "Directory" : "File"}
            </span>
          </div>

          {!isDir && (
            <div className="flex items-baseline gap-3 py-1">
              <span className={labelClass}>Size</span>
              <span className={valueClass}>{formatBytes(entry.size)}</span>
            </div>
          )}

          <div className="flex items-baseline gap-3 py-1">
            <span className={labelClass}>Location</span>
            <span className={`${valueClass} font-mono text-[length:var(--text-2xs)]`} title={location}>
              {location}
            </span>
          </div>

          <div className="flex items-baseline gap-3 py-1">
            <span className={labelClass}>Path</span>
            <span className={`${valueClass} font-mono text-[length:var(--text-2xs)]`} title={entry.id}>
              {entry.id}
            </span>
            <button
              onClick={copyPath}
              title="Copy path"
              aria-label="Copy path"
              className="shrink-0 p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-subtle transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Copy size={12} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>

          <div className="flex items-baseline gap-3 py-1">
            <span className={labelClass}>Modified</span>
            <span className={valueClass}>{modified}</span>
          </div>

          {capabilities.hasStorageClass && entry.storageClass && (
            <div className="flex items-baseline gap-3 py-1">
              <span className={labelClass}>Class</span>
              <span className={valueClass}>{entry.storageClass}</span>
            </div>
          )}
        </div>

        {/* Permissions */}
        {showPermissions && (
          <div className="px-4 py-3 border-t border-border">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[length:var(--text-xs)] font-semibold uppercase tracking-wide text-text-muted">
                Permissions
              </span>
              {entry.isSymlink && (
                <span className="text-[length:var(--text-2xs)] text-text-muted">read-only (symlink)</span>
              )}
            </div>

            <table className="w-full text-[length:var(--text-xs)] text-text-secondary">
              <thead>
                <tr className="text-text-muted">
                  <th className="text-left font-medium w-16" />
                  <th className="font-medium py-1">Read</th>
                  <th className="font-medium py-1">Write</th>
                  <th className="font-medium py-1">Execute</th>
                </tr>
              </thead>
              <tbody>
                {ROW_LABELS.map((rowLabel, r) => (
                  <tr key={rowLabel}>
                    <td className="py-1 text-text-secondary">{rowLabel}</td>
                    {ROW_KEYS[r].map((key, c) => (
                      <td key={key} className="text-center py-1">
                        <input
                          type="checkbox"
                          data-testid={`perm-${key}`}
                          checked={bits[key]}
                          disabled={!canEditPermissions}
                          onChange={() => toggleBit(key)}
                          className="h-3.5 w-3.5 cursor-pointer accent-accent disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label={`${rowLabel} ${COL_LABELS[c]}`}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="flex items-center gap-2 mt-3">
              <span className="text-[length:var(--text-xs)] text-text-muted">Octal</span>
              <input
                type="text"
                inputMode="numeric"
                data-testid="perm-octal"
                value={octalInput}
                disabled={!canEditPermissions}
                onChange={(e) => handleOctalInput(e.target.value)}
                onBlur={handleOctalBlur}
                className="w-16 px-2 py-1 rounded-md font-mono text-center text-[length:var(--text-sm)] text-text-primary bg-bg-base border border-border outline-none focus:border-border-focus focus:ring-2 focus:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Octal permissions"
              />
              <span className="font-mono text-[length:var(--text-2xs)] text-text-muted">
                {/* rwx preview, live */}
                {octalToPermissionsString(octal)}
              </span>
            </div>

            {/* Special-bit notice — these can't be edited here but are kept. */}
            {specialBits !== 0 && (
              <p
                data-testid="perm-special-bits"
                className="mt-2 text-[length:var(--text-2xs)] text-text-muted"
              >
                Special bits set ({specialBitsLabel}); not editable here and{" "}
                {recursive && isDir
                  ? "dropped on a recursive apply."
                  : "preserved on apply."}
              </p>
            )}

            {/* Recursive apply — directories only */}
            {isDir && canEditPermissions && (
              <label className="flex items-center gap-2 mt-3 cursor-pointer text-[length:var(--text-xs)] text-text-secondary select-none">
                <input
                  type="checkbox"
                  data-testid="perm-recursive"
                  checked={recursive}
                  disabled={applying}
                  onChange={(e) => setRecursive(e.target.checked)}
                  className="h-3.5 w-3.5 cursor-pointer accent-accent disabled:cursor-not-allowed disabled:opacity-50"
                />
                Apply permissions recursively to all contents
              </label>
            )}
          </div>
        )}

        {/* Error */}
        {error && (
          <div
            role="alert"
            aria-live="assertive"
            data-testid="file-properties-error"
            className="flex items-start gap-2 px-4 py-2 mx-4 mb-2 rounded-md bg-status-error/10 text-status-error"
          >
            <AlertCircle size={14} strokeWidth={2} aria-hidden="true" className="shrink-0 mt-0.5" />
            <p className="text-[length:var(--text-xs)] break-words min-w-0">{error}</p>
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border">
          <button
            data-testid="file-properties-cancel"
            onClick={onClose}
            disabled={applying}
            className="px-4 py-2 text-[length:var(--text-sm)] text-text-secondary hover:text-text-primary rounded-lg transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {canEditPermissions ? "Cancel" : "Close"}
          </button>
          {canEditPermissions && (
            <button
              data-testid="file-properties-apply"
              onClick={() => void handleApply()}
              disabled={!canApply || applying}
              className="flex items-center gap-1.5 px-4 py-2 text-[length:var(--text-sm)] font-medium text-white bg-accent hover:opacity-90 rounded-lg transition-opacity duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {applying && <Loader2 size={14} strokeWidth={2} className="animate-spin" aria-hidden="true" />}
              Apply
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
