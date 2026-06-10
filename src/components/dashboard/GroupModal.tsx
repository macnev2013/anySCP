import { useState, useEffect, useRef, useCallback } from "react";
import {
  Folder, Cloud, Server, Database, Globe, Shield, Code,
  Wifi, Home, Building2, Rocket, Wrench, Monitor, Lock,
  Zap, Cpu, HardDrive, Network, Radio, Warehouse,
} from "lucide-react";
import { HOST_COLORS } from "./HostCard";
import { ModalShell, BTN_GHOST, BTN_PRIMARY } from "../shared/ModalShell";

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
  const nameRef = useRef<HTMLInputElement>(null);
  const isEdit = !!initial;

  useEffect(() => {
    if (open) {
      setName(initial?.name ?? "");
      setColor(initial?.color ?? HOST_COLORS[4]);
      setIcon(initial?.icon ?? "Folder");
      setError(null);
      setSaving(false);
      // Focus the name field once the modal is open
      requestAnimationFrame(() => nameRef.current?.focus());
    }
  }, [open, initial]);

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

  const SelectedIcon = resolveGroupIcon(icon);

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
      title={isEdit ? "Edit Group" : "New Group"}
      iconNode={
        <div
          className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
          style={{ backgroundColor: `${color}20` }}
        >
          <SelectedIcon size={16} strokeWidth={1.8} style={{ color }} aria-hidden="true" />
        </div>
      }
      maxWidth="sm"
      busy={saving}
      testId="group-modal"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={saving} className={BTN_GHOST}>
            Cancel
          </button>
          <button
            form="group-modal-form"
            type="submit"
            data-testid="group-modal-save"
            disabled={saving || !name.trim()}
            className={BTN_PRIMARY}
          >
            {saving ? "Saving…" : isEdit ? "Save" : "Create Group"}
          </button>
        </>
      }
    >
      <form id="group-modal-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <label className={labelClass}>
            Name <span className="text-status-error">*</span>
          </label>
          <input
            ref={nameRef}
            data-testid="group-modal-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Production, Staging, Home Lab"
            disabled={saving}
            className={inputClass}
          />
        </div>

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
                  <Icon size={16} strokeWidth={isSelected ? 2 : 1.6} style={isSelected ? { color } : undefined} />
                </button>
              );
            })}
          </div>
        </div>

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

        {error && (
          <p className="text-[length:var(--text-sm)] text-status-error bg-status-error/10 rounded-lg px-3 py-2" role="alert">
            {error}
          </p>
        )}
      </form>
    </ModalShell>
  );
}
