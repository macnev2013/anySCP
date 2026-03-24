import { useState, useEffect, useRef, useCallback } from "react";
import { AlertTriangle } from "lucide-react";
import type { Snippet } from "../../types";
import { useSessionStore } from "../../stores/session-store";
import { CustomSelect } from "../shared/CustomSelect";
import {
  extractVariables,
  parseVariables,
  resolveCommand,
  resolveBuiltin,
  BUILTIN_NAMES,
} from "../../utils/snippet-resolve";

// ─── Types ────────────────────────────────────────────────────────────────────

interface VariableDialogProps {
  snippet: Snippet;
  onExecute: (resolvedCommand: string) => void;
  onCancel: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function VariableDialog({ snippet, onExecute, onCancel }: VariableDialogProps) {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const session = activeSessionId ? (sessions.get(activeSessionId) ?? null) : null;

  // Parsed variable metadata from snippet.variables JSON
  const variableMeta = parseVariables(snippet.variables);

  // All unique variable names extracted from the command
  const allVarNames = extractVariables(snippet.command);

  // Separate built-ins from user-defined
  const builtinVars = allVarNames.filter((n) => BUILTIN_NAMES.includes(n));
  const userVarNames = allVarNames.filter((n) => !BUILTIN_NAMES.includes(n));

  // Build initial values from defaults
  const initialValues = Object.fromEntries(
    userVarNames.map((name) => {
      const meta = variableMeta.find((v) => v.name === name);
      return [name, meta?.default_value ?? ""];
    }),
  );

  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const [visible, setVisible] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);
  const firstInputRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => {
        if (firstInputRef.current) firstInputRef.current.focus();
      });
    }
  }, [visible]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onCancel();
  };

  const handleExecute = useCallback(() => {
    const resolved = resolveCommand(snippet.command, values, session);
    onExecute(resolved);
  }, [snippet.command, values, session, onExecute]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleExecute();
  };

  const setValue = (name: string, value: string) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  };

  // Check required fields
  const hasUnmetRequired = userVarNames.some((name) => {
    const meta = variableMeta.find((v) => v.name === name);
    return meta?.required && !values[name]?.trim();
  });

  const inputClass = [
    "w-full rounded-lg bg-bg-base border border-border px-3 py-2",
    "text-[length:var(--text-sm)] text-text-primary placeholder:text-text-muted font-mono",
    "outline-none focus:border-border-focus focus:ring-2 focus:ring-ring",
    "transition-[border-color,box-shadow] duration-[var(--duration-fast)]",
  ].join(" ");

  const labelClass = "block text-[length:var(--text-xs)] font-medium text-text-secondary mb-1";

  let inputIndex = 0;

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
          "w-full max-w-md rounded-xl bg-bg-overlay border border-border p-6 shadow-[var(--shadow-lg)]",
          "transition-[opacity,transform] duration-[var(--duration-slow)] ease-[var(--ease-expo-out)]",
          visible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-3",
        ].join(" ")}
      >
        {/* Header */}
        <div className="mb-5">
          <h2 className="text-[length:var(--text-lg)] font-semibold text-text-primary">
            {snippet.name}
          </h2>
          <p className="text-[length:var(--text-xs)] text-text-muted mt-1 font-mono break-all line-clamp-2">
            {snippet.command}
          </p>
        </div>

        {/* Dangerous warning */}
        {snippet.is_dangerous && (
          <div className="flex items-start gap-2.5 p-3 mb-5 rounded-lg bg-status-error/10 border border-status-error/30">
            <AlertTriangle
              size={15}
              strokeWidth={2}
              className="text-status-error shrink-0 mt-0.5"
              aria-hidden="true"
            />
            <p className="text-[length:var(--text-xs)] text-status-error leading-relaxed">
              This snippet is flagged as dangerous. Review the resolved command carefully before execution.
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/* Built-in variables (read-only) */}
          {builtinVars.length > 0 && (
            <div className="flex flex-col gap-3">
              <p className="text-[length:var(--text-xs)] font-semibold uppercase tracking-widest text-text-muted">
                Auto-filled
              </p>
              {builtinVars.map((name) => {
                const resolved = resolveBuiltin(name, session) ?? "(no active session)";
                return (
                  <div key={name}>
                    <label className={labelClass}>
                      {`{{${name}}}`}
                    </label>
                    <div
                      className={[
                        "w-full rounded-lg bg-bg-base border border-border px-3 py-2",
                        "text-[length:var(--text-sm)] text-text-muted font-mono",
                        "cursor-default select-text",
                      ].join(" ")}
                    >
                      {resolved}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Divider if both sections present */}
          {builtinVars.length > 0 && userVarNames.length > 0 && (
            <hr className="border-border" />
          )}

          {/* User-defined variables */}
          {userVarNames.length > 0 && (
            <div className="flex flex-col gap-3">
              {userVarNames.length > 0 && builtinVars.length > 0 && (
                <p className="text-[length:var(--text-xs)] font-semibold uppercase tracking-widest text-text-muted">
                  Variables
                </p>
              )}
              {userVarNames.map((name) => {
                const meta = variableMeta.find((v) => v.name === name);
                const isFirst = inputIndex === 0;
                inputIndex++;

                const label = meta?.label ?? name;
                const placeholder = meta?.placeholder ?? `Enter ${name}`;
                const options = meta?.options ?? null;
                const required = meta?.required ?? false;

                return (
                  <div key={name}>
                    <label className={labelClass}>
                      {label}
                      {required && (
                        <span className="text-status-error ml-1" aria-label="required">*</span>
                      )}
                    </label>

                    {options && options.length > 0 ? (
                      <CustomSelect
                        value={values[name] ?? ""}
                        onChange={(v) => setValue(name, v)}
                        placeholder="— select —"
                        options={[
                          { value: "", label: "— select —" },
                          ...options.map((opt) => ({ value: opt, label: opt })),
                        ]}
                      />
                    ) : (
                      <input
                        ref={isFirst ? (el) => { firstInputRef.current = el; } : undefined}
                        type="text"
                        value={values[name] ?? ""}
                        onChange={(e) => setValue(name, e.target.value)}
                        placeholder={placeholder}
                        required={required}
                        className={inputClass}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* No variables — just confirm */}
          {allVarNames.length === 0 && (
            <p className="text-[length:var(--text-sm)] text-text-muted text-center py-2">
              No variables to fill in.
            </p>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 mt-1">
            <button
              type="button"
              onClick={onCancel}
              className={[
                "px-4 py-2 text-[length:var(--text-sm)] text-text-secondary",
                "hover:text-text-primary rounded-lg",
                "transition-colors duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              ].join(" ")}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={hasUnmetRequired}
              className={[
                "px-4 py-2 text-[length:var(--text-sm)] font-medium rounded-lg",
                "text-text-inverse bg-accent hover:bg-accent-hover",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                "transition-colors duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg-overlay",
              ].join(" ")}
            >
              Execute
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
