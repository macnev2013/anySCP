import { useState, useEffect, useRef, useCallback } from "react";
import {
  Folder, Cloud, Server, Database, Globe, Shield, Code,
  Wifi, Home, Building2, Rocket, Wrench, Monitor, Lock,
  Zap, Cpu, HardDrive, Network, Radio, Warehouse,
} from "lucide-react";
import { HOST_COLORS } from "./HostCard";

// ─── Icon registry ───────────────────────────────────────────────────────────

const GROUP_ICONS: { name: string; icon: React.ElementType }[] = [
  { name: "Folder", icon: Folder },
  { name: "Cloud", icon: Cloud },
  { name: "Server", icon: Server },
  { name: "Database", icon: Database },
  { name: "Globe", icon: Globe },
  { name: "Shield", icon: Shield },
  { name: "Code", icon: Code },
  { name: "Wifi", icon: Wifi },
  { name: "Home", icon: Home },
  { name: "Building2", icon: Building2 },
  { name: "Rocket", icon: Rocket },
  { name: "Wrench", icon: Wrench },
  { name: "Monitor", icon: Monitor },
  { name: "Lock", icon: Lock },
  { name: "Zap", icon: Zap },
  { name: "Cpu", icon: Cpu },
  { name: "HardDrive", icon: HardDrive },
  { name: "Network", icon: Network },
  { name: "Radio", icon: Radio },
  { name: "Warehouse", icon: Warehouse },
];

/** Resolve a stored icon name to its component. Falls back to Folder. */
export function resolveGroupIcon(name: string | null | undefined): React.ElementType {
  if (!name) return Folder;
  const found = GROUP_ICONS.find((i) => i.name === name);
  return found?.icon ?? Folder;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface GroupFormData {
  name: string;
  color: string;
  icon: string;
}

interface GroupModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: GroupFormData) => Promise<void>;
  initial?: { name: string; color: string; icon: string | null };
}

// ─── Component ───────────────────────────────────────────────────────────────

export function GroupModal({ open, onClose, onSave, initial }: GroupModalProps) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(HOST_COLORS[4]);
  const [icon, setIcon] = useState("Folder");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [visible, setVisible] = useState(false);

  const backdropRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const isEdit = !!initial;

  useEffect(() => {
    if (open) {
      setName(initial?.name ?? "");
      setColor(initial?.color ?? HOST_COLORS[4]);
      setIcon(initial?.icon ?? "Folder");
      setError(null);
      setSaving(false);
      requestAnimationFrame(() => setVisible(true));
    } else {
      setVisible(false);
    }
  }, [open, initial]);

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

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError("Group name is required"); return; }
    setSaving(true);
    setError(null);
    try {
      await onSave({ name: name.trim(), color, icon });
    } catch (err: unknown) {
      setError(
        err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : "Failed to save group",
      );
      setSaving(false);
    }
  }, [name, color, icon, onSave]);

  if (!open) return null;

  const inputClass = [
    "w-full rounded-lg bg-bg-base border border-border px-3 py-2",
    "text-[length:var(--text-sm)] text-text-primary placeholder:text-text-muted",
    "outline-none focus:border-border-focus focus:ring-2 focus:ring-ring",
    "transition-[border-color,box-shadow] duration-[var(--duration-fast)]",
  ].join(" ");

  const labelClass = "block text-[length:var(--text-xs)] font-medium text-text-secondary mb-1.5";

  const SelectedIcon = resolveGroupIcon(icon);

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className={`
        fixed inset-0 z-50 flex items-start justify-center pt-[12vh]
        transition-[background-color,backdrop-filter] duration-[var(--duration-base)]
        ${visible ? "bg-black/50 backdrop-blur-sm" : "bg-black/0 backdrop-blur-none"}
      `}
    >
      <div
        className={`
          w-full max-w-sm rounded-xl bg-bg-overlay border border-border p-6 shadow-[var(--shadow-lg)]
          transition-[opacity,transform] duration-[var(--duration-slow)] ease-[var(--ease-expo-out)]
          ${visible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-3"}
        `}
      >
        {/* Preview + Title */}
        <div className="flex items-center gap-3 mb-5">
          <div
            className="flex items-center justify-center w-10 h-10 rounded-lg shrink-0"
            style={{ backgroundColor: `${color}20` }}
          >
            <SelectedIcon size={20} strokeWidth={1.8} style={{ color }} />
          </div>
          <h2 className="text-[length:var(--text-lg)] font-semibold text-text-primary">
            {isEdit ? "Edit Group" : "New Group"}
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
              placeholder="e.g., Production, Staging, Home Lab"
              disabled={saving}
              className={inputClass}
            />
          </div>

          {/* Icon picker */}
          <div>
            <span className={labelClass}>Icon</span>
            <div className="grid grid-cols-10 gap-1">
              {GROUP_ICONS.map((item) => {
                const Icon = item.icon;
                const isSelected = icon === item.name;
                return (
                  <button
                    key={item.name}
                    type="button"
                    onClick={() => setIcon(item.name)}
                    disabled={saving}
                    title={item.name}
                    aria-label={item.name}
                    aria-pressed={isSelected}
                    className={[
                      "flex items-center justify-center w-8 h-8 rounded-lg",
                      "transition-all duration-[var(--duration-fast)]",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      isSelected
                        ? "bg-accent/15 ring-1 ring-accent"
                        : "hover:bg-bg-subtle text-text-muted hover:text-text-secondary",
                    ].join(" ")}
                  >
                    <Icon
                      size={15}
                      strokeWidth={isSelected ? 2 : 1.6}
                      style={isSelected ? { color } : undefined}
                    />
                  </button>
                );
              })}
            </div>
          </div>

          {/* Color */}
          <div>
            <span className={labelClass}>Color</span>
            <div className="flex items-center gap-2 flex-wrap">
              {HOST_COLORS.map((c) => (
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
            <p className="text-[length:var(--text-sm)] text-status-error bg-status-error/10 rounded-lg px-3 py-2" role="alert">
              {error}
            </p>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 mt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 text-[length:var(--text-sm)] text-text-secondary hover:text-text-primary rounded-lg transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !name.trim()}
              className="px-4 py-2 text-[length:var(--text-sm)] font-medium text-text-inverse bg-accent hover:bg-accent-hover disabled:opacity-50 rounded-lg transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg-overlay"
            >
              {saving ? "Saving\u2026" : isEdit ? "Save" : "Create Group"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
