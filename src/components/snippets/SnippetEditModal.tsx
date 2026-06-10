import { useState, useEffect, useRef, useCallback } from "react";
import { Braces } from "lucide-react";
import type { Snippet, SnippetFolder, SnippetVariable } from "../../types";
import { extractVariables, parseVariables } from "../../utils/snippet-resolve";
import { CustomSelect } from "../shared/CustomSelect";
import { ModalShell, BTN_GHOST, BTN_PRIMARY } from "../shared/ModalShell";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SnippetEditModalProps {
  open: boolean;
  initial: Snippet | null; // null = new snippet
  folders: SnippetFolder[];
  onClose: () => void;
  onSave: (snippet: Snippet) => Promise<void>;
  onSaveAndExecute: (snippet: Snippet) => Promise<void>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractError(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: string }).message);
  }
  return fallback;
}

function blankSnippet(): Snippet {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: "",
    command: "",
    description: null,
    folder_id: null,
    tags: null,
    variables: null,
    is_dangerous: false,
    use_count: 0,
    last_used_at: null,
    sort_order: 0,
    created_at: now,
    updated_at: now,
  };
}

// ─── Options input (keeps raw string while typing, parses on blur) ───────────

function OptionsInput({
  value,
  onChange,
  disabled,
  className,
}: {
  value: string[] | null;
  onChange: (opts: string[] | null) => void;
  disabled?: boolean;
  className: string;
}) {
  const [raw, setRaw] = useState(value ? value.join(", ") : "");

  // Sync from parent when value changes externally (e.g., on modal open)
  useEffect(() => {
    setRaw(value ? value.join(", ") : "");
  }, [value]);

  const commitValue = () => {
    const parsed = raw
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    onChange(parsed.length > 0 ? parsed : null);
  };

  return (
    <input
      type="text"
      value={raw}
      onChange={(e) => setRaw(e.target.value)}
      onBlur={commitValue}
      placeholder="e.g., start, stop, restart, status"
      disabled={disabled}
      className={className}
    />
  );
}

// ─── Variable row editor ─────────────────────────────────────────────────────

interface VariableRowProps {
  variable: SnippetVariable;
  onChange: (updated: SnippetVariable) => void;
  disabled?: boolean;
}

function VariableRow({ variable, onChange, disabled }: VariableRowProps) {
  const rowInputClass = [
    "w-full rounded-md bg-bg-base border border-border px-2.5 py-1.5",
    "text-[length:var(--text-xs)] text-text-primary placeholder:text-text-muted",
    "outline-none focus:border-border-focus focus:ring-1 focus:ring-ring",
    "transition-[border-color,box-shadow] duration-[var(--duration-fast)]",
  ].join(" ");

  const rowLabelClass = "text-[11px] font-medium text-text-muted uppercase tracking-wide";

  return (
    <div className="py-2.5 px-3 rounded-lg bg-bg-base border border-border flex flex-col gap-2">
      {/* Variable name + required toggle */}
      <div className="flex items-center justify-between">
        <span className="font-mono text-[length:var(--text-xs)] text-accent">
          {`{{${variable.name}}}`}
        </span>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={variable.required}
            onChange={(e) => onChange({ ...variable, required: e.target.checked })}
            disabled={disabled}
            className="w-3.5 h-3.5 rounded accent-accent"
          />
          <span className="text-[11px] text-text-muted">Required</span>
        </label>
      </div>

      {/* Fields in a 2-column grid */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <span className={rowLabelClass}>Label</span>
          <input
            type="text"
            value={variable.label ?? ""}
            onChange={(e) => onChange({ ...variable, label: e.target.value || null })}
            placeholder="Display label"
            disabled={disabled}
            className={rowInputClass}
          />
        </div>
        <div>
          <span className={rowLabelClass}>Default</span>
          <input
            type="text"
            value={variable.default_value ?? ""}
            onChange={(e) => onChange({ ...variable, default_value: e.target.value || null })}
            placeholder="Default value"
            disabled={disabled}
            className={rowInputClass}
          />
        </div>
      </div>

      {/* Options — full width */}
      <div>
        <span className={rowLabelClass}>Options (comma-separated)</span>
        <OptionsInput
          value={variable.options}
          onChange={(opts) => onChange({ ...variable, options: opts })}
          disabled={disabled}
          className={rowInputClass}
        />
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SnippetEditModal({
  open,
  initial,
  folders,
  onClose,
  onSave,
  onSaveAndExecute: _onSaveAndExecute,
}: SnippetEditModalProps) {
  const [form, setForm] = useState<Snippet>(blankSnippet());
  const [variableMeta, setVariableMeta] = useState<SnippetVariable[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const nameRef = useRef<HTMLInputElement>(null);
  const isEdit = !!initial;

  // Sync variable metadata whenever command changes
  const syncVariables = useCallback((command: string, existing: SnippetVariable[]) => {
    const names = extractVariables(command);
    // Preserve existing metadata, add new ones, remove stale ones
    const updated: SnippetVariable[] = names.map((name) => {
      const found = existing.find((v) => v.name === name);
      return found ?? {
        name,
        label: null,
        default_value: null,
        placeholder: null,
        options: null,
        required: false,
      };
    });
    setVariableMeta(updated);
  }, []);

  useEffect(() => {
    if (open) {
      const base = initial ?? blankSnippet();
      setForm(base);
      const parsed = parseVariables(base.variables);
      syncVariables(base.command, parsed);
      setError(null);
      setSaving(false);
      requestAnimationFrame(() => nameRef.current?.focus());
    }
  }, [open, initial, syncVariables]);

  const handleCommandChange = (cmd: string) => {
    setForm((f) => ({ ...f, command: cmd }));
    syncVariables(cmd, variableMeta);
  };

  const buildSnippet = (): Snippet => ({
    ...form,
    variables: variableMeta.length > 0 ? JSON.stringify(variableMeta) : null,
    updated_at: new Date().toISOString(),
  });

  const handleSave = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!form.name.trim()) { setError("Name is required"); return; }
      if (!form.command.trim()) { setError("Command is required"); return; }
      setSaving(true);
      setError(null);
      try {
        await onSave(buildSnippet());
      } catch (err: unknown) {
        setError(extractError(err, "Failed to save snippet"));
        setSaving(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [form, variableMeta, onSave],
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
    <ModalShell
      open={open}
      onClose={onClose}
      title={isEdit ? "Edit Snippet" : "New Snippet"}
      icon={Braces}
      maxWidth="xl"
      scrollable
      busy={saving}
      testId="snippet-modal"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={saving} className={BTN_GHOST}>
            Cancel
          </button>
          <button
            form="snippet-edit-form"
            type="submit"
            data-testid="snippet-modal-save"
            disabled={saving || !form.name.trim() || !form.command.trim()}
            className={BTN_PRIMARY}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <form id="snippet-edit-form" onSubmit={handleSave} className="flex flex-col gap-5">
          {/* Name */}
          <div>
            <label className={labelClass}>
              Name <span className="text-status-error">*</span>
            </label>
            <input
              ref={nameRef}
              data-testid="snippet-modal-name"
              type="text"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g., Restart Nginx"
              disabled={saving}
              required
              className={inputClass}
            />
          </div>

          {/* Command */}
          <div>
            <label className={labelClass}>
              Command <span className="text-status-error">*</span>
            </label>
            <textarea
              data-testid="snippet-modal-command"
              value={form.command}
              onChange={(e) => handleCommandChange(e.target.value)}
              placeholder="e.g., sudo systemctl restart {{service}}"
              disabled={saving}
              required
              rows={4}
              className={[
                inputClass,
                "font-mono resize-y min-h-[4rem]",
              ].join(" ")}
            />
            <p className="mt-1 text-[11px] text-text-muted">
              Use <span className="font-mono text-accent">{"{{variable_name}}"}</span> syntax to define variables.
            </p>
          </div>

          {/* Description */}
          <div>
            <label className={labelClass}>Description</label>
            <textarea
              value={form.description ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value || null }))}
              placeholder="Optional — describe what this snippet does"
              disabled={saving}
              rows={2}
              className={[inputClass, "resize-y min-h-[3rem]"].join(" ")}
            />
          </div>

          {/* Folder + Tags row */}
          <div className="grid grid-cols-2 gap-4">
            {/* Folder */}
            <div>
              <label className={labelClass}>Folder</label>
              <CustomSelect
                value={form.folder_id ?? ""}
                onChange={(v) => setForm((f) => ({ ...f, folder_id: v || null }))}
                disabled={saving}
                placeholder="No folder"
                options={[
                  { value: "", label: "No folder" },
                  ...folders.map((folder) => ({
                    value: folder.id,
                    label: folder.name,
                  })),
                ]}
              />
            </div>

            {/* Tags */}
            <div>
              <label className={labelClass}>Tags</label>
              <input
                type="text"
                value={form.tags ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value || null }))}
                placeholder="nginx, restart, devops"
                disabled={saving}
                className={inputClass}
              />
            </div>
          </div>

          {/* Dangerous flag */}
          <label className="flex items-start gap-3 cursor-pointer group">
            <input
              type="checkbox"
              checked={form.is_dangerous}
              onChange={(e) => setForm((f) => ({ ...f, is_dangerous: e.target.checked }))}
              disabled={saving}
              className="mt-0.5 w-4 h-4 rounded accent-accent"
            />
            <div>
              <span className="text-[length:var(--text-sm)] font-medium text-text-secondary group-hover:text-text-primary transition-colors duration-[var(--duration-fast)]">
                Flag as dangerous
              </span>
              <p className="text-[length:var(--text-xs)] text-text-muted mt-0.5">
                Requires confirmation before execution.
              </p>
            </div>
          </label>

          {/* Variables section — auto-detected */}
          {variableMeta.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-[length:var(--text-xs)] font-semibold uppercase tracking-widest text-text-muted">
                  Variables
                </span>
                <span className="text-[11px] text-text-muted bg-bg-subtle border border-border rounded-full px-2 py-0.5">
                  {variableMeta.length} detected
                </span>
              </div>

              {/* Column headers */}
              <div className="grid grid-cols-[auto_1fr_1fr_1fr_auto] gap-2 px-3 mb-1">
                {["Variable", "Label", "Default", "Options", "Req"].map((h) => (
                  <span key={h} className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
                    {h}
                  </span>
                ))}
              </div>

              <div className="flex flex-col gap-2">
                {variableMeta.map((variable) => (
                  <VariableRow
                    key={variable.name}
                    variable={variable}
                    disabled={saving}
                    onChange={(updated) =>
                      setVariableMeta((prev) =>
                        prev.map((v) => (v.name === updated.name ? updated : v)),
                      )
                    }
                  />
                ))}
              </div>
            </div>
          )}


        {error && (
          <p className="text-[length:var(--text-sm)] text-status-error bg-status-error/10 rounded-lg px-3 py-2" role="alert">
            {error}
          </p>
        )}
      </form>
    </ModalShell>
  );
}
