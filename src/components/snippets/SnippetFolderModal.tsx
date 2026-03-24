import { useState, useEffect, useRef, useCallback } from "react";
import { Folder } from "lucide-react";

// ─── Folder colors ────────────────────────────────────────────────────────────

export const FOLDER_COLORS = [
  "oklch(0.700 0.150 250)", // accent blue
  "oklch(0.720 0.180 155)", // green
  "oklch(0.750 0.160 80)",  // amber
  "oklch(0.650 0.200 25)",  // red
  "oklch(0.720 0.160 295)", // purple
  "oklch(0.700 0.150 200)", // teal
  "oklch(0.680 0.140 340)", // pink
  "oklch(0.580 0.010 264)", // neutral
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface FolderFormData {
  name: string;
  color: string;
}

interface SnippetFolderModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: FolderFormData) => Promise<void>;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SnippetFolderModal({ open, onClose, onSave }: SnippetFolderModalProps) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(FOLDER_COLORS[0]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [visible, setVisible] = useState(false);

  const backdropRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setColor(FOLDER_COLORS[0]);
      setError(null);
      setSaving(false);
      requestAnimationFrame(() => setVisible(true));
    } else {
      setVisible(false);
    }
  }, [open]);

  useEffect(() => {
    if (visible) requestAnimationFrame(() => nameRef.current?.focus());
  }, [visible]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose();
  };

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!name.trim()) { setError("Folder name is required"); return; }
      setSaving(true);
      setError(null);
      try {
        await onSave({ name: name.trim(), color });
      } catch (err: unknown) {
        setError(
          err && typeof err === "object" && "message" in err
            ? String((err as { message: string }).message)
            : "Failed to save folder",
        );
        setSaving(false);
      }
    },
    [name, color, onSave],
  );

  if (!open) return null;

  const inputClass = [
    "w-full rounded-lg bg-bg-base border border-border px-3 py-2",
    "text-[length:var(--text-sm)] text-text-primary placeholder:text-text-muted",
    "outline-none focus:border-border-focus focus:ring-2 focus:ring-ring",
    "transition-[border-color,box-shadow] duration-[var(--duration-fast)]",
  ].join(" ");

  const labelClass = "block text-[length:var(--text-xs)] font-medium text-text-secondary mb-1.5";

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className={[
        "fixed inset-0 z-50 flex items-start justify-center pt-[12vh]",
        "transition-[background-color,backdrop-filter] duration-[var(--duration-base)]",
        visible ? "bg-black/50 backdrop-blur-sm" : "bg-black/0 backdrop-blur-none",
      ].join(" ")}
    >
      <div
        className={[
          "w-full max-w-sm rounded-xl bg-bg-overlay border border-border p-6 shadow-[var(--shadow-lg)]",
          "transition-[opacity,transform] duration-[var(--duration-slow)] ease-[var(--ease-expo-out)]",
          visible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-3",
        ].join(" ")}
      >
        {/* Preview + title */}
        <div className="flex items-center gap-3 mb-5">
          <div
            className="flex items-center justify-center w-10 h-10 rounded-lg shrink-0"
            style={{ backgroundColor: `${color}20` }}
          >
            <Folder size={20} strokeWidth={1.8} style={{ color }} aria-hidden="true" />
          </div>
          <h2 className="text-[length:var(--text-lg)] font-semibold text-text-primary">
            New Folder
          </h2>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/* Name */}
          <div>
            <label className={labelClass}>
              Name <span className="text-status-error">*</span>
            </label>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Web Servers, Docker, Database"
              disabled={saving}
              className={inputClass}
            />
          </div>

          {/* Color picker */}
          <div>
            <span className={labelClass}>Color</span>
            <div className="flex items-center gap-2 flex-wrap">
              {FOLDER_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  disabled={saving}
                  aria-label={`Color ${c}`}
                  aria-pressed={color === c}
                  className={[
                    "w-7 h-7 rounded-full border-2",
                    "transition-[border-color,box-shadow,transform] duration-[var(--duration-fast)]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-bg-overlay",
                    color === c
                      ? "border-white ring-2 ring-ring scale-110"
                      : "border-transparent hover:border-white/60 hover:scale-105",
                  ].join(" ")}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>

          {/* Error */}
          {error && (
            <p
              className="text-[length:var(--text-sm)] text-status-error bg-status-error/10 rounded-lg px-3 py-2"
              role="alert"
            >
              {error}
            </p>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 mt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className={[
                "px-4 py-2 text-[length:var(--text-sm)] text-text-secondary",
                "hover:text-text-primary rounded-lg",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                "transition-colors duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              ].join(" ")}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !name.trim()}
              className={[
                "px-4 py-2 text-[length:var(--text-sm)] font-medium rounded-lg",
                "text-text-inverse bg-accent hover:bg-accent-hover",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                "transition-colors duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg-overlay",
              ].join(" ")}
            >
              {saving ? "Creating\u2026" : "Create Folder"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
