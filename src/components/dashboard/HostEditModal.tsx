import { useState, useCallback, useEffect, useRef } from "react";
import { useUiStore } from "../../stores/ui-store";
import { useHostsStore } from "../../stores/hosts-store";
import { useGroupsStore } from "../../stores/groups-store";
import { useSessionStore } from "../../stores/session-store";
import { useTabStore } from "../../stores/tab-store";
import type { SavedHost, HostConfig, StoredCredential } from "../../types";
import { HOST_COLORS } from "./HostCard";
import { CustomSelect } from "../shared/CustomSelect";

// ─── Field types ─────────────────────────────────────────────────────────────

type AuthType = "password" | "privateKey";

/** Sentinel value: when editingHostId === NEW_HOST_ID, we create a new host
 *  instead of loading an existing one. */
export const NEW_HOST_ID = "__new__";

interface FormState {
  // Connection
  label: string;
  host: string;
  port: string;
  username: string;
  authType: AuthType;
  groupId: string;
  keyPath: string;
  proxyJump: string;
  keepAliveInterval: string;
  defaultShell: string;
  startupCommand: string;
  // Auth credentials (only used at connect-time, never persisted)
  password: string;
  passphrase: string;
  // Appearance
  color: string;
  environment: string;
  osType: string;
  // Notes
  notes: string;
}

const EMPTY_FORM: FormState = {
  label: "",
  host: "",
  port: "22",
  username: "",
  authType: "password",
  groupId: "",
  keyPath: "",
  proxyJump: "",
  keepAliveInterval: "",
  defaultShell: "",
  startupCommand: "",
  password: "",
  passphrase: "",
  color: "",
  environment: "",
  osType: "",
  notes: "",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractError(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: string }).message);
  }
  return fallback;
}

function savedHostToForm(host: SavedHost): FormState {
  const authType: AuthType =
    host.auth_type === "privateKey" ? "privateKey" : "password";
  return {
    label: host.label ?? "",
    host: host.host,
    port: String(host.port),
    username: host.username,
    authType,
    groupId: host.group_id ?? "",
    keyPath: host.key_path ?? "",
    proxyJump: host.proxy_jump ?? "",
    keepAliveInterval: host.keep_alive_interval != null ? String(host.keep_alive_interval) : "",
    defaultShell: host.default_shell ?? "",
    startupCommand: host.startup_command ?? "",
    password: "",
    passphrase: "",
    color: host.color ?? "",
    environment: host.environment ?? "",
    osType: host.os_type ?? "",
    notes: host.notes ?? "",
  };
}

// ─── Section header ───────────────────────────────────────────────────────────

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

// ─── Component ────────────────────────────────────────────────────────────────

export function HostEditModal() {
  const editingHostId = useUiStore((s) => s.editingHostId);
  const setEditingHostId = useUiStore((s) => s.setEditingHostId);

  const saveHost = useHostsStore((s) => s.saveHost);
  const deleteHost = useHostsStore((s) => s.deleteHost);
  const groups = useGroupsStore((s) => s.groups);
  const loadGroups = useGroupsStore((s) => s.loadGroups);
  const addSession = useSessionStore((s) => s.addSession);

  // Animation gate — separate from editingHostId to allow exit animation
  const [visible, setVisible] = useState(false);

  // Original host snapshot (preserved for id + created_at on save)
  const [originalHost, setOriginalHost] = useState<SavedHost | null>(null);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loadingHost, setLoadingHost] = useState(false);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  // Vault credential state
  /** True when the keychain already holds a credential for this host. */
  const [hasSavedCred, setHasSavedCred] = useState(false);
  /** True when the user has explicitly clicked "Clear" on the saved credential. */
  const [credCleared, setCredCleared] = useState(false);

  const backdropRef = useRef<HTMLDivElement>(null);
  const hostInputRef = useRef<HTMLInputElement>(null);
  const scrollBodyRef = useRef<HTMLDivElement>(null);

  const isOpen = editingHostId !== null;

  // ── Close helper ────────────────────────────────────────────────────────────
  const close = useCallback(() => {
    setEditingHostId(null);
  }, [setEditingHostId]);

  const isNewHost = editingHostId === NEW_HOST_ID;

  // ── Load SSH keys once ──────────────────────────────────────────────────────
  const [sshKeys, setSshKeys] = useState<import("../../types").SshKeyInfo[]>([]);
  const sshKeysLoaded = useRef(false);

  useEffect(() => {
    if (sshKeysLoaded.current) return;
    let cancelled = false;
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const keys = await invoke<import("../../types").SshKeyInfo[]>("list_ssh_keys");
        if (!cancelled) setSshKeys(keys);
      } catch { /* non-fatal */ }
      finally { sshKeysLoaded.current = true; }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Load host data when modal opens ────────────────────────────────────────
  useEffect(() => {
    if (!isOpen || !editingHostId) {
      setVisible(false);
      return;
    }

    // Reset transient state
    setError(null);
    setDeleteConfirm(false);
    setSaving(false);
    setConnecting(false);
    setOriginalHost(null);
    setForm(EMPTY_FORM);
    setHasSavedCred(false);
    setCredCleared(false);

    // Load groups in parallel
    loadGroups().catch(() => {/* non-fatal */});

    if (isNewHost) {
      // New host — no fetch needed
      setLoadingHost(false);
      requestAnimationFrame(() => setVisible(true));
      return;
    }

    setLoadingHost(true);

    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const [host, hasCred] = await Promise.all([
          invoke<SavedHost>("get_host", { id: editingHostId }),
          invoke<boolean>("vault_has_credential", { hostId: editingHostId }).catch(() => false),
        ]);
        setOriginalHost(host);
        setForm(savedHostToForm(host));
        setHasSavedCred(hasCred);
      } catch (err) {
        setError(extractError(err, "Failed to load host data"));
      } finally {
        setLoadingHost(false);
        requestAnimationFrame(() => setVisible(true));
      }
    })();
  }, [isOpen, editingHostId, isNewHost, loadGroups]);

  // Scroll to top and focus Host field when modal opens
  useEffect(() => {
    if (visible && !loadingHost) {
      requestAnimationFrame(() => {
        scrollBodyRef.current?.scrollTo(0, 0);
        hostInputRef.current?.focus();
      });
    }
  }, [visible, loadingHost]);

  // ── Escape key ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (deleteConfirm) {
          setDeleteConfirm(false);
        } else {
          close();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, deleteConfirm, close]);

  // ── Backdrop click ──────────────────────────────────────────────────────────
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current) close();
  };

  // ── Form field updater ──────────────────────────────────────────────────────
  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setError(null);
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  // ── Validation ──────────────────────────────────────────────────────────────
  const validate = (): string | null => {
    if (!form.host.trim()) return "Host is required";
    if (!form.username.trim()) return "Username is required";
    const portNum = parseInt(form.port, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      return "Port must be between 1 and 65535";
    }
    if (form.keepAliveInterval !== "") {
      const kai = parseInt(form.keepAliveInterval, 10);
      if (isNaN(kai) || kai < 0) return "Keep Alive must be a positive number";
    }
    return null;
  };

  // ── Build SavedHost from form (works for both new and edit) ─────────────────
  const buildHost = (): SavedHost => {
    const now = new Date().toISOString();
    const base: SavedHost = originalHost ?? {
      id: crypto.randomUUID(),
      label: "",
      host: "",
      port: 22,
      username: "",
      auth_type: "password",
      group_id: null,
      created_at: now,
      updated_at: now,
      key_path: null,
      color: null,
      notes: null,
      environment: null,
      os_type: null,
      startup_command: null,
      proxy_jump: null,
      keep_alive_interval: null,
      default_shell: null,
      font_size: null,
      last_connected_at: null,
      connection_count: null,
    };
    return {
      ...base,
      label: form.label.trim(),
      host: form.host.trim(),
      port: parseInt(form.port, 10),
      username: form.username.trim(),
      auth_type: form.authType,
      group_id: form.groupId === "" ? null : form.groupId,
      updated_at: new Date().toISOString(),
      key_path: form.authType === "privateKey" && form.keyPath.trim()
        ? form.keyPath.trim()
        : null,
      proxy_jump: form.proxyJump.trim() || null,
      keep_alive_interval: form.keepAliveInterval.trim()
        ? parseInt(form.keepAliveInterval, 10)
        : null,
      default_shell: form.defaultShell.trim() || null,
      startup_command: form.startupCommand.trim() || null,
      color: form.color || null,
      environment: form.environment || null,
      os_type: form.osType || null,
      notes: form.notes.trim() || null,
    };
  };

  // ── Vault helpers ────────────────────────────────────────────────────────────

  /** Saves a credential to the OS keychain, or removes it if credCleared. */
  const syncVaultCredential = async (
    hostId: string,
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
  ): Promise<void> => {
    if (credCleared) {
      // User explicitly cleared — remove from keychain (non-fatal if it didn't exist)
      try {
        await invoke("vault_delete_credential", { hostId });
      } catch { /* non-fatal */ }
      return;
    }

    if (form.authType === "password" && form.password) {
      const credential: StoredCredential = { type: "Password", password: form.password };
      await invoke("vault_save_credential", { hostId, credential });
    } else if (form.authType === "privateKey" && form.passphrase) {
      const credential: StoredCredential = { type: "KeyPassphrase", passphrase: form.passphrase };
      await invoke("vault_save_credential", { hostId, credential });
    }
    // If the field is empty and not cleared, leave the existing keychain entry untouched.
  };

  // ── Save ────────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    const validationError = validate();
    if (validationError) { setError(validationError); return; }

    setSaving(true);
    setError(null);
    try {
      const host = buildHost();
      await saveHost(host);

      const { invoke } = await import("@tauri-apps/api/core");
      await syncVaultCredential(host.id, invoke as (cmd: string, args?: Record<string, unknown>) => Promise<unknown>);

      close();
    } catch (err) {
      setError(extractError(err, "Failed to save host"));
    } finally {
      setSaving(false);
    }
  };

  // ── Connect (save → vault → connect_saved_host) ─────────────────────────────
  const handleConnect = async () => {
    const validationError = validate();
    if (validationError) { setError(validationError); return; }

    setConnecting(true);
    setError(null);
    try {
      const host = buildHost();
      await saveHost(host);

      const { invoke } = await import("@tauri-apps/api/core");
      const typedInvoke = invoke as (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

      // Persist credential to keychain before connecting — the Rust backend
      // reads credentials exclusively from the keychain, never from the frontend.
      await syncVaultCredential(host.id, typedInvoke);

      // The backend resolves host config + credentials from its own DB and keychain.
      const sessionId = await invoke<string>("connect_saved_host", { hostId: host.id });

      // Build a minimal HostConfig for the session store label — no credentials.
      const hostConfig: HostConfig = {
        host: host.host,
        port: host.port,
        username: host.username,
        label: host.label || undefined,
        auth_method:
          form.authType === "privateKey"
            ? { type: "privateKey", key_path: form.keyPath }
            : { type: "password", password: "" },
      };
      addSession(sessionId, hostConfig);
      const label = hostConfig.label || `${hostConfig.username}@${hostConfig.host}`;
      useTabStore.getState().addTab({ type: "terminal", id: sessionId, label });
      close();
    } catch (err) {
      setError(extractError(err, "Connection failed"));
    } finally {
      setConnecting(false);
    }
  };

  // ── Delete ───────────────────────────────────────────────────────────────────
  const handleDeleteConfirmed = async () => {
    if (!editingHostId) return;
    setSaving(true);
    setError(null);
    try {
      await deleteHost(editingHostId);
      close();
    } catch (err) {
      setError(extractError(err, "Failed to delete host"));
      setSaving(false);
      setDeleteConfirm(false);
    }
  };

  if (!isOpen) return null;

  const isBusy = saving || connecting;

  // ── Shared input class ───────────────────────────────────────────────────────
  const inputClass =
    "w-full rounded-lg bg-bg-base border border-border px-3 py-2 text-[length:var(--text-sm)] text-text-primary placeholder:text-text-muted outline-none focus:border-border-focus focus:ring-2 focus:ring-ring transition-[border-color,box-shadow] duration-[var(--duration-fast)]";

  const labelClass =
    "block text-[length:var(--text-xs)] font-medium text-text-secondary mb-1";



  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className={`
        fixed inset-0 z-50 flex items-start justify-center pt-[8vh]
        transition-[background-color,backdrop-filter] duration-[var(--duration-base)]
        ${visible ? "bg-black/50 backdrop-blur-sm" : "bg-black/0 backdrop-blur-none"}
      `}
    >
      <div
        className={`
          w-full max-w-lg rounded-xl bg-bg-overlay border border-border shadow-[var(--shadow-lg)]
          flex flex-col max-h-[84vh]
          transition-[opacity,transform] duration-[var(--duration-slow)] ease-[var(--ease-expo-out)]
          ${visible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-3"}
        `}
      >
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border shrink-0">
          <h2 className="text-[length:var(--text-lg)] font-semibold text-text-primary">
            {isNewHost ? "New Host" : "Edit Host"}
          </h2>
          <button
            onClick={close}
            disabled={isBusy}
            aria-label="Close"
            className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-subtle transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path
                d="M1 1l12 12M13 1L1 13"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* ── Scrollable body ─────────────────────────────────────────────── */}
        <div ref={scrollBodyRef} className="px-6 py-4 overflow-y-auto flex-1 min-h-0">
          {loadingHost ? (
            <LoadingSkeleton />
          ) : (
            <div className="flex flex-col gap-3.5">

              {/* ════════════════ CONNECTION ════════════════ */}
              <SectionHeader>Connection</SectionHeader>

              {/* Label */}
              <div>
                <label htmlFor="hem-label" className={labelClass}>
                  Label
                  <span className="ml-1 text-text-muted font-normal">(optional)</span>
                </label>
                <input
                  id="hem-label"
                  type="text"
                  value={form.label}
                  onChange={(e) => setField("label", e.target.value)}
                  placeholder="e.g., Production Server"
                  disabled={isBusy}
                  className={inputClass}
                />
              </div>

              {/* Host + Port row */}
              <div className="flex gap-3">
                <div className="flex-1">
                  <label htmlFor="hem-host" className={labelClass}>
                    Host <RequiredMark />
                  </label>
                  <input
                    ref={hostInputRef}
                    id="hem-host"
                    type="text"
                    value={form.host}
                    onChange={(e) => setField("host", e.target.value)}
                    placeholder="192.168.1.1 or hostname"
                    disabled={isBusy}
                    className={`${inputClass} font-mono`}
                  />
                </div>
                <div className="w-20">
                  <label htmlFor="hem-port" className={labelClass}>
                    Port <RequiredMark />
                  </label>
                  <input
                    id="hem-port"
                    type="number"
                    min={1}
                    max={65535}
                    value={form.port}
                    onChange={(e) => setField("port", e.target.value)}
                    disabled={isBusy}
                    className={`${inputClass} font-mono`}
                  />
                </div>
              </div>

              {/* Username */}
              <div>
                <label htmlFor="hem-username" className={labelClass}>
                  Username <RequiredMark />
                </label>
                <input
                  id="hem-username"
                  type="text"
                  value={form.username}
                  onChange={(e) => setField("username", e.target.value)}
                  placeholder="root"
                  disabled={isBusy}
                  className={`${inputClass} font-mono`}
                />
              </div>

              {/* Auth Type + Group row */}
              <div className="flex gap-3">
                <div className="flex-1">
                  <label htmlFor="hem-auth" className={labelClass}>
                    Auth Type
                  </label>
                  <CustomSelect
                    id="hem-auth"
                    value={form.authType}
                    onChange={(v) => setField("authType", v as AuthType)}
                    disabled={isBusy}
                    options={[
                      { value: "password", label: "Password" },
                      { value: "privateKey", label: "Private Key" },
                    ]}
                  />
                </div>

                <div className="flex-1">
                  <label htmlFor="hem-group" className={labelClass}>
                    Group
                  </label>
                  <GroupSelect
                    id="hem-group"
                    value={form.groupId}
                    onChange={(val) => setField("groupId", val)}
                    groups={groups}
                    disabled={isBusy}
                    inputClass={inputClass}
                  />
                </div>
              </div>

              {/* Auth credentials — conditional on auth type */}
              {form.authType === "password" ? (
                <div>
                  <label htmlFor="hem-password" className={labelClass}>
                    Password
                  </label>
                  <input
                    id="hem-password"
                    type="password"
                    value={form.password}
                    onChange={(e) => setField("password", e.target.value)}
                    placeholder={
                      hasSavedCred && !credCleared && !form.password
                        ? "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"
                        : "Enter password to connect"
                    }
                    disabled={isBusy}
                    className={inputClass}
                  />
                  <CredentialStatus
                    visible={hasSavedCred && !credCleared && !form.password}
                    busy={isBusy}
                    onClear={() => setCredCleared(true)}
                  />
                </div>
              ) : (
                <>
                  <div>
                    <label htmlFor="hem-keypath" className={labelClass}>
                      SSH Key
                    </label>
                    <div className="flex gap-2">
                      <div className="flex-1 min-w-0">
                        {sshKeys.length > 0 ? (
                          <CustomSelect
                            id="hem-keypath"
                            value={form.keyPath}
                            onChange={(v) => setField("keyPath", v)}
                            disabled={isBusy}
                            placeholder="Select a key..."
                            options={sshKeys.map((key) => ({
                              value: key.path,
                              label: `${key.name} (${key.algorithm})`,
                            }))}
                          />
                        ) : (
                          <input
                            id="hem-keypath"
                            type="text"
                            value={form.keyPath}
                            onChange={(e) => setField("keyPath", e.target.value)}
                            placeholder="~/.ssh/id_ed25519"
                            disabled={isBusy}
                            className={`${inputClass} font-mono`}
                          />
                        )}
                      </div>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => {
                          void (async () => {
                            try {
                              const { open } = await import("@tauri-apps/plugin-dialog");
                              const { invoke } = await import("@tauri-apps/api/core");
                              const path = await open({
                                title: "Select SSH Private Key (Cmd+Shift+. to show hidden files)",
                                multiple: false,
                              });
                              if (path && typeof path === "string") {
                                // Validate and inspect the key
                                try {
                                  const keyInfo = await invoke<import("../../types").SshKeyInfo>("inspect_ssh_key", { path });
                                  setField("keyPath", keyInfo.path);
                                  if (!sshKeys.some((k) => k.path === keyInfo.path)) {
                                    setSshKeys((prev) => [...prev, keyInfo]);
                                  }
                                } catch (err) {
                                  const msg = err && typeof err === "object" && "message" in err
                                    ? String((err as { message: string }).message)
                                    : "Invalid key file";
                                  setError(msg);
                                }
                              }
                            } catch {
                              // Dialog cancelled or unavailable
                            }
                          })();
                        }}
                        className={[
                          "px-3 py-2 rounded-lg text-[length:var(--text-sm)] font-medium shrink-0",
                          "bg-bg-base border border-border text-text-secondary",
                          "hover:border-border-focus hover:text-text-primary hover:bg-bg-overlay",
                          "transition-all duration-[var(--duration-fast)]",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          "disabled:opacity-50",
                        ].join(" ")}
                      >
                        Browse
                      </button>
                    </div>
                    {form.keyPath && !sshKeys.some((k) => k.path === form.keyPath) && (
                      <p className="text-[length:var(--text-2xs)] font-mono text-text-muted mt-1 truncate" title={form.keyPath}>
                        {form.keyPath}
                      </p>
                    )}
                  </div>
                  <div>
                    <label htmlFor="hem-passphrase" className={labelClass}>
                      Passphrase
                      <span className="ml-1 text-text-muted font-normal">(optional)</span>
                    </label>
                    <input
                      id="hem-passphrase"
                      type="password"
                      value={form.passphrase}
                      onChange={(e) => setField("passphrase", e.target.value)}
                      placeholder={
                        hasSavedCred && !credCleared && !form.passphrase
                          ? "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"
                          : "Leave empty if none"
                      }
                      disabled={isBusy}
                      className={inputClass}
                    />
                    <CredentialStatus
                      visible={hasSavedCred && !credCleared && !form.passphrase}
                      busy={isBusy}
                      onClear={() => setCredCleared(true)}
                    />
                  </div>
                </>
              )}

              {/* TODO: Proxy / Jump Host — hidden until backend support is implemented */}

              {/* Keep Alive + Default Shell row */}
              <div className="flex gap-3">
                <div className="flex-1">
                  <label htmlFor="hem-keepalive" className={labelClass}>
                    Keep Alive
                    <span className="ml-1 text-text-muted font-normal">(seconds)</span>
                  </label>
                  <input
                    id="hem-keepalive"
                    type="number"
                    min={0}
                    value={form.keepAliveInterval}
                    onChange={(e) => setField("keepAliveInterval", e.target.value)}
                    placeholder="60"
                    disabled={isBusy}
                    className={`${inputClass} font-mono`}
                  />
                </div>
                <div className="flex-1">
                  <label htmlFor="hem-shell" className={labelClass}>
                    Default Shell
                  </label>
                  <input
                    id="hem-shell"
                    type="text"
                    value={form.defaultShell}
                    onChange={(e) => setField("defaultShell", e.target.value)}
                    placeholder="/bin/zsh"
                    disabled={isBusy}
                    className={`${inputClass} font-mono`}
                  />
                </div>
              </div>

              {/* Startup Command */}
              <div>
                <label htmlFor="hem-startup" className={labelClass}>
                  Startup Command
                  <span className="ml-1 text-text-muted font-normal">(optional)</span>
                </label>
                <input
                  id="hem-startup"
                  type="text"
                  value={form.startupCommand}
                  onChange={(e) => setField("startupCommand", e.target.value)}
                  placeholder="cd /app && tail -f logs"
                  disabled={isBusy}
                  className={`${inputClass} font-mono`}
                />
                {/* TODO: startup_command execution should be handled in the Rust backend
                    after the shell prompt is detected — not sent as raw input from the frontend. */}
              </div>

              {/* ════════════════ APPEARANCE ════════════════ */}
              <SectionHeader>Appearance</SectionHeader>

              {/* Color swatches */}
              <div>
                <span className={labelClass}>Color</span>
                <div className="flex items-center gap-2 flex-wrap">
                  {/* Auto option — clears custom color */}
                  <button
                    type="button"
                    onClick={() => setField("color", "")}
                    disabled={isBusy}
                    title="Auto (hash-based)"
                    aria-label="Auto color"
                    className={[
                      "w-6 h-6 rounded-full border-2 text-[10px] font-bold",
                      "flex items-center justify-center",
                      "transition-[border-color,box-shadow] duration-[var(--duration-fast)]",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      form.color === ""
                        ? "border-border-focus ring-2 ring-ring"
                        : "border-border hover:border-border-focus",
                    ].join(" ")}
                    style={{ background: "conic-gradient(#ef4444, #f97316, #eab308, #22c55e, #06b6d4, #8b5cf6, #ef4444)" }}
                  >
                    <span className="sr-only">Auto</span>
                  </button>

                  {HOST_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setField("color", c)}
                      disabled={isBusy}
                      title={c}
                      aria-label={`Color ${c}`}
                      aria-pressed={form.color === c}
                      className={[
                        "w-6 h-6 rounded-full border-2",
                        "transition-[border-color,box-shadow] duration-[var(--duration-fast)]",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-bg-overlay",
                        form.color === c
                          ? "border-white ring-2 ring-ring scale-110"
                          : "border-transparent hover:border-white/60 hover:scale-105",
                      ].join(" ")}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              </div>

              {/* Environment + OS Type row */}
              <div className="flex gap-3">
                <div className="flex-1">
                  <label htmlFor="hem-env" className={labelClass}>
                    Environment
                  </label>
                  <CustomSelect
                    id="hem-env"
                    value={form.environment}
                    onChange={(v) => setField("environment", v)}
                    disabled={isBusy}
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
                  <label htmlFor="hem-os" className={labelClass}>
                    OS Type
                  </label>
                  <CustomSelect
                    id="hem-os"
                    value={form.osType}
                    onChange={(v) => setField("osType", v)}
                    disabled={isBusy}
                    placeholder="Auto"
                    options={[
                      { value: "", label: "Auto" },
                      { value: "linux", label: "Linux" },
                      { value: "macos", label: "macOS" },
                      { value: "windows", label: "Windows" },
                      { value: "freebsd", label: "FreeBSD" },
                    ]}
                  />
                </div>
              </div>

              {/* ════════════════ NOTES ════════════════ */}
              <SectionHeader>Notes</SectionHeader>

              <div>
                <label htmlFor="hem-notes" className={labelClass}>
                  Notes
                  <span className="ml-1 text-text-muted font-normal">(optional)</span>
                </label>
                <textarea
                  id="hem-notes"
                  rows={3}
                  value={form.notes}
                  onChange={(e) => setField("notes", e.target.value)}
                  placeholder="Notes about this server..."
                  disabled={isBusy}
                  className={`${inputClass} resize-none`}
                />
              </div>

              {/* Error banner */}
              {error && (
                <p
                  role="alert"
                  className="text-[length:var(--text-sm)] text-status-error bg-status-error/10 rounded-lg px-3 py-2"
                >
                  {error}
                </p>
              )}
            </div>
          )}
        </div>

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <div className="px-6 pb-5 pt-3 flex items-center justify-between gap-2 border-t border-border shrink-0">
          {/* Left: Delete / delete confirmation (hidden for new hosts) */}
          <div className="flex items-center gap-2">
            {isNewHost ? (
              <span />
            ) : deleteConfirm ? (
              <DeleteConfirmRow
                onCancel={() => setDeleteConfirm(false)}
                onConfirm={handleDeleteConfirmed}
                busy={isBusy}
              />
            ) : (
              <button
                type="button"
                onClick={() => setDeleteConfirm(true)}
                disabled={isBusy || loadingHost}
                className="px-3 py-2 text-[length:var(--text-sm)] text-status-error hover:bg-status-error/10 rounded-lg transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Delete
              </button>
            )}
          </div>

          {/* Right: Cancel / Save / Connect */}
          {!deleteConfirm && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={close}
                disabled={isBusy}
                className="px-4 py-2 text-[length:var(--text-sm)] text-text-secondary hover:text-text-primary rounded-lg transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={isBusy || loadingHost}
                className="px-4 py-2 text-[length:var(--text-sm)] font-medium text-text-secondary hover:text-text-primary bg-bg-subtle hover:bg-bg-muted disabled:opacity-50 rounded-lg border border-border transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {saving ? "Saving\u2026" : "Save"}
              </button>
              <button
                type="button"
                onClick={handleConnect}
                disabled={isBusy || loadingHost}
                className="px-4 py-2 text-[length:var(--text-sm)] font-medium text-text-inverse bg-accent hover:bg-accent-hover disabled:opacity-50 rounded-lg transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg-overlay"
              >
                {connecting ? "Connecting\u2026" : "Connect"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function RequiredMark() {
  return (
    <span className="ml-0.5 text-status-error" aria-hidden="true">
      *
    </span>
  );
}

interface GroupSelectProps {
  id: string;
  value: string;
  onChange: (val: string) => void;
  groups: { id: string; name: string; color: string }[];
  disabled: boolean;
  inputClass: string;
}

function GroupSelect({ id, value, onChange, groups, disabled }: GroupSelectProps) {
  return (
    <CustomSelect
      id={id}
      value={value}
      onChange={onChange}
      disabled={disabled}
      placeholder="No group"
      options={[
        { value: "", label: "No group" },
        ...groups.map((g) => ({
          value: g.id,
          label: g.name,
        })),
      ]}
    />
  );
}

// ─── CredentialStatus ─────────────────────────────────────────────────────────

interface CredentialStatusProps {
  /** Whether to show the badge at all. */
  visible: boolean;
  busy: boolean;
  onClear: () => void;
}

/**
 * Shown below a password/passphrase field when a credential is already
 * saved in the OS keychain.  The actual secret is never sent to the frontend —
 * only the boolean "exists" flag comes from Rust.
 */
function CredentialStatus({ visible, busy, onClear }: CredentialStatusProps) {
  if (!visible) return null;
  return (
    <div className="flex items-center justify-between mt-1.5 px-2.5 py-1.5 rounded-md bg-bg-subtle border border-border">
      <div className="flex items-center gap-1.5 text-[length:var(--text-xs)] text-text-secondary">
        {/* Lock icon — inline SVG to avoid adding another icon import */}
        <svg
          width="11"
          height="11"
          viewBox="0 0 12 14"
          fill="none"
          aria-hidden="true"
          className="text-text-muted shrink-0"
        >
          <rect
            x="1"
            y="6"
            width="10"
            height="7"
            rx="1.5"
            stroke="currentColor"
            strokeWidth="1.3"
          />
          <path
            d="M4 6V4a2 2 0 1 1 4 0v2"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
        Credential saved in system keychain
      </div>
      <button
        type="button"
        onClick={onClear}
        disabled={busy}
        aria-label="Clear saved credential"
        className={[
          "text-[length:var(--text-xs)] text-text-muted hover:text-status-error",
          "transition-colors duration-[var(--duration-fast)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded px-1",
        ].join(" ")}
      >
        Clear
      </button>
    </div>
  );
}

// ─── DeleteConfirmRow ─────────────────────────────────────────────────────────

interface DeleteConfirmRowProps {
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}

function DeleteConfirmRow({ onCancel, onConfirm, busy }: DeleteConfirmRowProps) {
  return (
    <div className="flex items-center gap-2 animate-in fade-in slide-in-from-left-1 duration-[var(--duration-fast)]">
      <span className="text-[length:var(--text-xs)] text-text-secondary whitespace-nowrap">
        Delete this host?
      </span>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className="px-3 py-1.5 text-[length:var(--text-xs)] text-text-secondary hover:text-text-primary rounded-md transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={onConfirm}
        disabled={busy}
        autoFocus
        className="px-3 py-1.5 text-[length:var(--text-xs)] font-medium text-text-inverse bg-status-error hover:opacity-90 disabled:opacity-50 rounded-md transition-[opacity] duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {busy ? "Deleting\u2026" : "Delete"}
      </button>
    </div>
  );
}

function LoadingSkeleton() {
  const skeletonClass = "rounded-md bg-bg-subtle animate-pulse";

  return (
    <div className="flex flex-col gap-3.5" aria-label="Loading host data">
      {/* Section header skeleton */}
      <div className={`h-3 w-24 ${skeletonClass}`} />
      {/* Host + port row */}
      <div className="flex gap-3">
        <div className="flex-1">
          <div className={`h-3 w-8 mb-2 ${skeletonClass}`} />
          <div className={`h-9 w-full ${skeletonClass}`} />
        </div>
        <div className="w-20">
          <div className={`h-3 w-6 mb-2 ${skeletonClass}`} />
          <div className={`h-9 w-full ${skeletonClass}`} />
        </div>
      </div>
      {/* Username row */}
      <div>
        <div className={`h-3 w-14 mb-2 ${skeletonClass}`} />
        <div className={`h-9 w-full ${skeletonClass}`} />
      </div>
      {/* Auth + group row */}
      <div className="flex gap-3">
        <div className="flex-1">
          <div className={`h-3 w-14 mb-2 ${skeletonClass}`} />
          <div className={`h-9 w-full ${skeletonClass}`} />
        </div>
        <div className="flex-1">
          <div className={`h-3 w-10 mb-2 ${skeletonClass}`} />
          <div className={`h-9 w-full ${skeletonClass}`} />
        </div>
      </div>
      {/* Two more field rows */}
      <div>
        <div className={`h-3 w-20 mb-2 ${skeletonClass}`} />
        <div className={`h-9 w-full ${skeletonClass}`} />
      </div>
      <div className="flex gap-3">
        <div className="flex-1">
          <div className={`h-3 w-16 mb-2 ${skeletonClass}`} />
          <div className={`h-9 w-full ${skeletonClass}`} />
        </div>
        <div className="flex-1">
          <div className={`h-3 w-16 mb-2 ${skeletonClass}`} />
          <div className={`h-9 w-full ${skeletonClass}`} />
        </div>
      </div>
    </div>
  );
}
