import { useState, useEffect, useRef } from "react";
import { Cloud } from "lucide-react";
import { useS3Store } from "../../stores/s3-store";
import { ModalShell, BTN_GHOST, BTN_SECONDARY, BTN_PRIMARY } from "../shared/ModalShell";
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
    <ModalShell
      open
      onClose={onClose}
      title={isEdit ? "Edit Connection" : "Connect to S3"}
      icon={Cloud}
      maxWidth="lg"
      scrollable
      busy={connecting || saving}
      testId="s3-dialog"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={connecting || saving} className={BTN_GHOST}>
            Cancel
          </button>
          {isEdit ? (
            <button type="button" onClick={() => void handleSave()} disabled={saving || !canSubmit} className={BTN_PRIMARY}>
              {saving ? "Saving…" : "Save Changes"}
            </button>
          ) : (
            <>
              <button type="button" data-testid="s3-dialog-save" onClick={() => void handleSave()} disabled={saving || connecting || !canSubmit} className={BTN_SECONDARY}>
                {saving ? "Saving…" : "Save"}
              </button>
              <button type="button" data-testid="s3-dialog-connect" onClick={() => void handleConnect()} disabled={connecting || saving || !canSubmit} className={BTN_PRIMARY}>
                {connecting ? "Connecting…" : "Connect"}
              </button>
            </>
          )}
        </>
      }
    >
        <div className="flex flex-col gap-3.5">
          <SectionHeader>Provider</SectionHeader>

          <div>
            <label className={labelClass}>Service</label>
            <CustomSelect
              data-testid="s3-dialog-provider"
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
              data-testid="s3-dialog-label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="My S3 Bucket"
              className={inputClass}
              autoFocus
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
              data-testid="s3-dialog-access-key"
              type="text"
              value={accessKey}
              onChange={(e) => setAccessKey(e.target.value)}
              placeholder={isEdit ? "••••••••••••" : "AKIAIOSFODNN7EXAMPLE"}
              className={`${inputClass} font-mono`}
            />
          </div>

          <div>
            <label className={labelClass}>Secret Access Key</label>
            <input
              data-testid="s3-dialog-secret-key"
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
                data-testid="s3-dialog-region"
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
                data-testid="s3-dialog-bucket"
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
                data-testid="s3-dialog-endpoint"
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
    </ModalShell>
  );
}
