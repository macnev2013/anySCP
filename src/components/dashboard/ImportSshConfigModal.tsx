import { useEffect, useState } from "react";
import { Loader2, AlertCircle, Check, FileText } from "lucide-react";
import { ModalShell, BTN_GHOST, BTN_PRIMARY } from "../shared/ModalShell";
import type { SshConfigEntry, ImportResult } from "../../types";

interface ImportSshConfigModalProps {
  onClose: () => void;
  onImported: () => void;
}

export function ImportSshConfigModal({ onClose, onImported }: ImportSshConfigModalProps) {
  const [entries, setEntries] = useState<SshConfigEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(true);
  const [importing, setImporting] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [configPath, setConfigPath] = useState<string | null>(null);

  // Scan on mount
  useEffect(() => {
    void scan(null);
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !importing) onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, importing]);

  const scan = async (path: string | null) => {
    setScanning(true);
    setScanError(null);
    setEntries([]);
    setSelected(new Set());
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const results = await invoke<SshConfigEntry[]>("import_parse_ssh_config", {
        path,
      });
      setEntries(results);
      // Auto-select non-pattern, non-duplicate entries
      const autoSelected = new Set<string>();
      for (const e of results) {
        if (!e.is_pattern && !e.already_exists) {
          autoSelected.add(e.host_alias);
        }
      }
      setSelected(autoSelected);
    } catch (err) {
      const msg = err && typeof err === "object" && "message" in err
        ? String((err as { message: string }).message)
        : "Failed to parse SSH config";
      setScanError(msg);
    } finally {
      setScanning(false);
    }
  };

  const handleBrowse = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        title: "Select SSH config file",
        multiple: false,
      });
      if (path && typeof path === "string") {
        setConfigPath(path);
        await scan(path);
      }
    } catch { /* cancelled */ }
  };

  const handleImport = async () => {
    setImporting(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const toImport = entries
        .filter((e) => selected.has(e.host_alias) && !e.is_pattern)
        .map((e) => ({
          host_alias: e.host_alias,
          hostname: e.hostname || e.host_alias,
          user: e.user || "root",
          port: e.port ?? 22,
          identity_file: e.identity_file,
          proxy_jump: e.proxy_jump,
          keep_alive_interval: e.keep_alive_interval,
        }));

      const importResult = await invoke<ImportResult>("import_save_ssh_hosts", {
        entries: toImport,
      });
      setResult(importResult);
      onImported();
    } catch (err) {
      const msg = err && typeof err === "object" && "message" in err
        ? String((err as { message: string }).message)
        : "Import failed";
      setScanError(msg);
    } finally {
      setImporting(false);
    }
  };

  const toggleSelect = (alias: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(alias)) next.delete(alias);
      else next.add(alias);
      return next;
    });
  };

  const selectAll = () => {
    const all = new Set<string>();
    for (const e of entries) {
      if (!e.is_pattern) all.add(e.host_alias);
    }
    setSelected(all);
  };

  const selectNone = () => setSelected(new Set());

  const importableCount = entries.filter((e) => selected.has(e.host_alias) && !e.is_pattern).length;

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Import SSH Config"
      maxWidth="lg"
      scrollable
      busy={importing}
      footer={
        result ? (
          <button type="button" onClick={onClose} className={BTN_PRIMARY}>Done</button>
        ) : (
          <>
            <button type="button" onClick={onClose} disabled={importing} className={BTN_GHOST}>Cancel</button>
            <button
              type="button"
              data-testid="import-ssh-config-submit"
              onClick={() => void handleImport()}
              disabled={importing || importableCount === 0}
              className={BTN_PRIMARY}
            >
              {importing ? "Importing…" : `Import ${importableCount} host${importableCount !== 1 ? "s" : ""}`}
            </button>
          </>
        )
      }
    >
        <div>
          {/* Result view */}
          {result ? (
            <div className="flex flex-col items-center gap-4 py-8">
              <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-status-connected/10">
                <Check size={26} strokeWidth={2} className="text-status-connected" />
              </div>
              <div className="text-center">
                <p className="text-[length:var(--text-sm)] font-semibold text-text-primary">
                  {result.imported} host{result.imported !== 1 ? "s" : ""} imported
                </p>
                {result.skipped > 0 && (
                  <p className="text-[length:var(--text-xs)] text-text-muted mt-1">
                    {result.skipped} skipped
                  </p>
                )}
                {result.errors.length > 0 && (
                  <div className="mt-3 text-left">
                    {result.errors.map((err, i) => (
                      <p key={i} className="text-[length:var(--text-xs)] text-status-error">{err}</p>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : scanning ? (
            <div className="flex flex-col items-center gap-4 py-12">
              <Loader2 size={26} strokeWidth={2} className="text-accent motion-safe:animate-spin" />
              <p className="text-[length:var(--text-sm)] text-text-muted">Scanning SSH config...</p>
            </div>
          ) : scanError ? (
            <div className="flex flex-col items-center gap-4 py-8">
              <AlertCircle size={26} strokeWidth={1.8} className="text-status-error" />
              <p className="text-[length:var(--text-sm)] text-status-error text-center">{scanError}</p>
              <button
                onClick={handleBrowse}
                className="px-4 py-2 text-[length:var(--text-sm)] font-medium text-text-inverse bg-accent hover:bg-accent-hover rounded-lg transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Browse for config file
              </button>
            </div>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center gap-4 py-8">
              <FileText size={26} strokeWidth={1.5} className="text-text-muted/40" />
              <p className="text-[length:var(--text-sm)] text-text-muted">No hosts found in SSH config</p>
              <button
                onClick={handleBrowse}
                className="px-3 py-1.5 text-[length:var(--text-xs)] font-medium text-text-muted border border-border rounded-lg hover:text-text-primary hover:bg-bg-overlay transition-all duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Try a different file
              </button>
            </div>
          ) : (
            <>
              {/* Config path + browse */}
              <div className="flex items-center gap-2 mb-4">
                <span className="text-[length:var(--text-2xs)] font-mono text-text-muted truncate flex-1">
                  {configPath ?? "~/.ssh/config"}
                </span>
                <button
                  onClick={() => void handleBrowse()}
                  className="text-[length:var(--text-2xs)] text-accent hover:text-accent-hover transition-colors duration-[var(--duration-fast)] shrink-0"
                >
                  Change
                </button>
              </div>

              {/* Select all / none */}
              <div className="flex items-center gap-3 mb-3">
                <span className="text-[length:var(--text-xs)] text-text-muted">
                  {importableCount} of {entries.filter((e) => !e.is_pattern).length} selected
                </span>
                <button onClick={selectAll} className="text-[length:var(--text-2xs)] text-accent hover:text-accent-hover">All</button>
                <button onClick={selectNone} className="text-[length:var(--text-2xs)] text-accent hover:text-accent-hover">None</button>
              </div>

              {/* Host list */}
              <div className="rounded-lg bg-bg-base border border-border/60 divide-y divide-border/30 overflow-hidden">
                {entries.map((entry) => {
                  const isChecked = selected.has(entry.host_alias);
                  const disabled = entry.is_pattern;

                  return (
                    <label
                      key={entry.host_alias}
                      className={[
                        "flex items-center gap-3 px-3 py-2 cursor-pointer",
                        "hover:bg-bg-overlay/40 transition-colors duration-[var(--duration-fast)]",
                        disabled ? "opacity-40 cursor-not-allowed" : "",
                      ].join(" ")}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={disabled}
                        onChange={() => !disabled && toggleSelect(entry.host_alias)}
                        className="w-3.5 h-3.5 rounded border-border text-accent focus:ring-ring shrink-0"
                      />

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[length:var(--text-sm)] font-medium text-text-primary truncate">
                            {entry.host_alias}
                          </span>
                          {entry.is_pattern && (
                            <span className="px-1.5 py-px rounded text-[9px] uppercase tracking-wide font-semibold bg-bg-subtle text-text-muted">
                              pattern
                            </span>
                          )}
                          {entry.already_exists && (
                            <span className="px-1.5 py-px rounded text-[9px] uppercase tracking-wide font-semibold bg-status-connecting/10 text-status-connecting">
                              exists
                            </span>
                          )}
                        </div>
                        <p className="text-[length:var(--text-2xs)] font-mono text-text-muted truncate">
                          {entry.user ?? "root"}@{entry.hostname ?? entry.host_alias}:{entry.port ?? 22}
                          {entry.identity_file && ` key:${entry.identity_file.split("/").pop()}`}
                        </p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </>
          )}
        </div>
    </ModalShell>
  );
}
