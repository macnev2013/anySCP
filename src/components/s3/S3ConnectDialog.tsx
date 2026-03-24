import { useState, useEffect, useRef } from "react";
import { useS3Store } from "../../stores/s3-store";
import { useGroupsStore } from "../../stores/groups-store";
import { CustomSelect } from "../shared/CustomSelect";
import { S3_PROVIDERS } from "../../types";
import type { S3Provider, S3Connection } from "../../types";

interface S3ConnectDialogProps {
  onClose: () => void;
  /** When provided, the dialog enters edit mode and pre-populates fields. */
  editConnection?: S3Connection;
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 my-1">
      <span className="text-[length:var(--text-xs)] font-semibold uppercase tracking-widest text-text-muted whitespace-nowrap">
        {children}
      </span>
      <div className="flex-1 h-px bg-border" aria-hidden="true" />
    </div>
  );
}

export function S3ConnectDialog({ onClose, editConnection }: S3ConnectDialogProps) {
  const isEdit = !!editConnection;
  const [provider, setProvider] = useState<S3Provider>(
    (editConnection?.provider as S3Provider) ?? "aws",
  );
  const [label, setLabel] = useState(editConnection?.label ?? "");
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [region, setRegion] = useState(editConnection?.region ?? "us-east-1");
  const [endpoint, setEndpoint] = useState(editConnection?.endpoint ?? "");
  const [bucket, setBucket] = useState(editConnection?.bucket ?? "");
  const [pathStyle, setPathStyle] = useState(editConnection?.path_style ?? false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track if provider was changed by user (not initial mount / edit pre-populate)
  const providerInitRef = useRef(true);

  // Update defaults when provider changes — only for new connections or user-initiated changes
  useEffect(() => {
    if (providerInitRef.current) {
      providerInitRef.current = false;
      if (isEdit) return; // Don't overwrite pre-populated values on mount
    }
    const preset = S3_PROVIDERS.find((p) => p.id === provider);
    if (preset) {
      setRegion(preset.regionPlaceholder);
      setEndpoint(preset.endpointPattern);
      setPathStyle(preset.pathStyle);
    }
  }, [provider, isEdit]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !connecting) onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, connecting]);

  const [groupId, setGroupId] = useState(editConnection?.group_id ?? "");
  const [color, setColor] = useState<string | null>(editConnection?.color ?? null);
  const [environment, setEnvironment] = useState(editConnection?.environment ?? "");
  const [notes, setNotes] = useState(editConnection?.notes ?? "");

  const groups = useGroupsStore((s) => s.groups);
  const loadGroups = useGroupsStore((s) => s.loadGroups);
  useEffect(() => { void loadGroups(); }, [loadGroups]);
  const [saving, setSaving] = useState(false);

  // In edit mode, credentials are optional (leave blank to keep existing)
  const canSubmit = isEdit
    ? region.trim() && bucket.trim()
    : accessKey.trim() && secretKey.trim() && region.trim() && bucket.trim();

  const handleSave = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");

      if (isEdit) {
        // Update existing connection: reuse the ID
        // If credentials are provided, update them; otherwise keep existing vault entry
        const hasNewCreds = accessKey.trim() && secretKey.trim();
        await invoke("s3_update_connection", {
          id: editConnection.id,
          label: label.trim() || `${provider}/${bucket.trim()}`,
          provider,
          bucketName: bucket.trim(),
          region: region.trim(),
          endpoint: endpoint.trim() || null,
          pathStyle,
          groupId: groupId || null,
          color,
          environment: environment || null,
          notes: notes.trim() || null,
          accessKey: hasNewCreds ? accessKey.trim() : null,
          secretKey: hasNewCreds ? secretKey.trim() : null,
        });
      } else {
        await invoke<string>("s3_save_connection", {
          label: label.trim() || `${provider}/${bucket.trim()}`,
          provider,
          bucketName: bucket.trim(),
          region: region.trim(),
          endpoint: endpoint.trim() || null,
          accessKey: accessKey.trim(),
          secretKey: secretKey.trim(),
          pathStyle,
          groupId: groupId || null,
          color,
          environment: environment || null,
          notes: notes.trim() || null,
        });
      }
      onClose();
    } catch (err) {
      const msg = err && typeof err === "object" && "message" in err
        ? String((err as { message: string }).message)
        : "Save failed";
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleConnect = async () => {
    if (!canSubmit) return;
    setConnecting(true);
    setError(null);

    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const sessionId = await invoke<string>("s3_connect", {
        label: label.trim() || `${provider}/${bucket.trim()}`,
        provider,
        bucketName: bucket.trim(),
        region: region.trim(),
        endpoint: endpoint.trim() || null,
        accessKey: accessKey.trim(),
        secretKey: secretKey.trim(),
        pathStyle,
        groupId: groupId || null,
      });

      useS3Store.getState().openSession(sessionId, label.trim() || `${provider}/${bucket.trim()}`);
      onClose();
    } catch (err) {
      const msg = err && typeof err === "object" && "message" in err
        ? String((err as { message: string }).message)
        : "Connection failed";
      setError(msg);
    } finally {
      setConnecting(false);
    }
  };

  const inputClass =
    "w-full rounded-lg bg-bg-base border border-border px-3 py-2 text-[length:var(--text-sm)] text-text-primary placeholder:text-text-muted outline-none focus:border-border-focus focus:ring-2 focus:ring-ring transition-[border-color,box-shadow] duration-[var(--duration-fast)]";

  const labelClass =
    "block text-[length:var(--text-xs)] font-medium text-text-secondary mb-1";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh]"
      style={{ backgroundColor: "oklch(0 0 0 / 0.5)", backdropFilter: "blur(4px)" }}
      onClick={(e) => e.target === e.currentTarget && !connecting && onClose()}
    >
      <div className="w-full max-w-lg rounded-xl bg-bg-overlay border border-border shadow-[var(--shadow-lg)] flex flex-col max-h-[84vh] animate-[fadeIn_120ms_var(--ease-expo-out)_both]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border shrink-0">
          <h2 className="text-[length:var(--text-lg)] font-semibold text-text-primary">
            {isEdit ? "Edit Connection" : "Connect to S3"}
          </h2>
          <button
            onClick={onClose}
            disabled={connecting}
            aria-label="Close"
            className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-subtle transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 overflow-y-auto flex-1 min-h-0 flex flex-col gap-3.5">
          <SectionHeader>Provider</SectionHeader>

          <div>
            <label className={labelClass}>Service</label>
            <CustomSelect
              value={provider}
              onChange={(v) => setProvider(v as S3Provider)}
              options={S3_PROVIDERS.map((p) => ({ value: p.id, label: p.label }))}
            />
          </div>

          <div>
            <label className={labelClass}>
              Label
              <span className="ml-1 text-text-muted font-normal">(optional)</span>
            </label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="My S3 Bucket"
              className={inputClass}
            />
          </div>

          <SectionHeader>Credentials</SectionHeader>

          {isEdit && (
            <p className="text-[length:var(--text-2xs)] text-text-muted -mb-1">
              Leave blank to keep existing credentials
            </p>
          )}

          <div>
            <label className={labelClass}>Access Key ID</label>
            <input
              type="text"
              value={accessKey}
              onChange={(e) => setAccessKey(e.target.value)}
              placeholder={isEdit ? "••••••••••••" : "AKIAIOSFODNN7EXAMPLE"}
              className={`${inputClass} font-mono`}
              autoFocus={!isEdit}
            />
          </div>

          <div>
            <label className={labelClass}>Secret Access Key</label>
            <input
              type="password"
              value={secretKey}
              onChange={(e) => setSecretKey(e.target.value)}
              placeholder={isEdit ? "••••••••••••" : "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}
              className={`${inputClass} font-mono`}
            />
          </div>

          <SectionHeader>Connection</SectionHeader>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className={labelClass}>Region</label>
              <input
                type="text"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                placeholder="us-east-1"
                className={`${inputClass} font-mono`}
              />
            </div>
            <div className="flex-1">
              <label className={labelClass}>Bucket</label>
              <input
                type="text"
                value={bucket}
                onChange={(e) => setBucket(e.target.value)}
                placeholder="my-bucket"
                className={`${inputClass} font-mono`}
              />
            </div>
          </div>

          {(provider !== "aws") && (
            <div>
              <label className={labelClass}>Endpoint URL</label>
              <input
                type="text"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder="https://s3.example.com"
                className={`${inputClass} font-mono`}
              />
            </div>
          )}

          <SectionHeader>Appearance</SectionHeader>

          {groups.length > 0 && (
            <div>
              <label className={labelClass}>Group</label>
              <CustomSelect
                value={groupId}
                onChange={setGroupId}
                placeholder="No group"
                options={[
                  { value: "", label: "No group" },
                  ...groups.map((g) => ({ value: g.id, label: g.name })),
                ]}
              />
            </div>
          )}

          <div className="flex gap-3">
            <div className="flex-1">
              <label className={labelClass}>Environment</label>
              <CustomSelect
                value={environment}
                onChange={setEnvironment}
                placeholder="None"
                options={[
                  { value: "", label: "None" },
                  { value: "production", label: "Production" },
                  { value: "staging", label: "Staging" },
                  { value: "dev", label: "Dev" },
                  { value: "testing", label: "Testing" },
                ]}
              />
            </div>
            <div className="flex-1">
              <label className={labelClass}>Color</label>
              <div className="flex gap-1.5 py-2">
                {["#6366f1", "#8b5cf6", "#ec4899", "#f43f5e", "#f97316", "#eab308", "#22c55e", "#06b6d4"].map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(color === c ? null : c)}
                    className={[
                      "w-6 h-6 rounded-full border-2 transition-all duration-[var(--duration-fast)]",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      color === c ? "border-text-primary scale-110" : "border-transparent hover:scale-110",
                    ].join(" ")}
                    style={{ background: c }}
                    aria-label={`Color ${c}`}
                  />
                ))}
              </div>
            </div>
          </div>

          <SectionHeader>Notes</SectionHeader>

          <div>
            <label className={labelClass}>
              Notes
              <span className="ml-1 text-text-muted font-normal">(optional)</span>
            </label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Notes about this connection..."
              className={`${inputClass} resize-none`}
            />
          </div>

          {/* Error */}
          {error && (
            <p role="alert" className="text-[length:var(--text-sm)] text-status-error bg-status-error/10 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 pb-5 pt-3 flex items-center justify-end gap-2 border-t border-border shrink-0">
          <button
            onClick={onClose}
            disabled={connecting || saving}
            className="px-4 py-2 text-[length:var(--text-sm)] text-text-secondary hover:text-text-primary rounded-lg transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Cancel
          </button>
          {isEdit ? (
            <button
              onClick={() => void handleSave()}
              disabled={saving || !canSubmit}
              className="px-4 py-2 text-[length:var(--text-sm)] font-medium text-text-inverse bg-accent hover:bg-accent-hover disabled:opacity-50 rounded-lg transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {saving ? "Saving…" : "Save Changes"}
            </button>
          ) : (
            <>
              <button
                onClick={() => void handleSave()}
                disabled={saving || connecting || !canSubmit}
                className="px-4 py-2 text-[length:var(--text-sm)] font-medium text-text-secondary hover:text-text-primary bg-bg-subtle hover:bg-bg-muted disabled:opacity-50 rounded-lg border border-border transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                onClick={() => void handleConnect()}
                disabled={connecting || saving || !canSubmit}
                className="px-4 py-2 text-[length:var(--text-sm)] font-medium text-text-inverse bg-accent hover:bg-accent-hover disabled:opacity-50 rounded-lg transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {connecting ? "Connecting…" : "Connect"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
