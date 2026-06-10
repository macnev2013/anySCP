import { useState, useEffect, useRef, useCallback } from "react";
import { Folder } from "lucide-react";
import { ModalShell, BTN_GHOST, BTN_PRIMARY } from "../shared/ModalShell";

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
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setColor(FOLDER_COLORS[0]);
      setError(null);
      setSaving(false);
      requestAnimationFrame(() => nameRef.current?.focus());
    }
  }, [open]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
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
  }, [name, color, onSave]);

  const inputClass = [
    "w-full rounded-lg bg-bg-base border border-border px-3 py-2",
    "text-[length:var(--text-sm)] text-text-primary placeholder:text-text-muted",
    "outline-none focus:border-border-focus focus:ring-2 focus:ring-ring",
    "transition-[border-color,box-shadow] duration-[var(--duration-fast)]",
  ].join(" ");

  const labelClass = "block text-[length:var(--text-xs)] font-medium text-text-secondary mb-1.5";

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="New Folder"
      iconNode={
        <div
          className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
          style={{ backgroundColor: `${color}20` }}
        >
          <Folder size={16} strokeWidth={1.8} style={{ color }} aria-hidden="true" />
        </div>
      }
      maxWidth="sm"
      busy={saving}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={saving} className={BTN_GHOST}>
            Cancel
          </button>
          <button
            form="snippet-folder-form"
            type="submit"
            disabled={saving || !name.trim()}
            className={BTN_PRIMARY}
          >
            {saving ? "Creating…" : "Create Folder"}
          </button>
        </>
      }
    >
      <form id="snippet-folder-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
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

        {error && (
          <p className="text-[length:var(--text-sm)] text-status-error bg-status-error/10 rounded-lg px-3 py-2" role="alert">
            {error}
          </p>
        )}
      </form>
    </ModalShell>
  );
}
