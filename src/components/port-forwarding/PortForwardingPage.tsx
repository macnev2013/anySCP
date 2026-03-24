import { useEffect, useState, useCallback, useMemo } from "react";
import { Plus, Trash2, ArrowRight, Search, Wifi, Pencil, Copy, Clock } from "lucide-react";
import { CustomSelect } from "../shared/CustomSelect";
import { usePortForwardStore } from "../../stores/port-forward-store";
import { useHostsStore } from "../../stores/hosts-store";
import { ContextMenu } from "../shared/ContextMenu";
import type { ContextMenuItem } from "../shared/ContextMenu";
import type { PortForwardRule, SavedHost } from "../../types";

// ─── Component ───────────────────────────────────────────────────────────────

export function PortForwardingPage() {
  const rules = usePortForwardStore((s) => s.rules);
  const activeTunnels = usePortForwardStore((s) => s.activeTunnels);
  const loadRules = usePortForwardStore((s) => s.loadRules);
  const createRule = usePortForwardStore((s) => s.createRule);
  const deleteRule = usePortForwardStore((s) => s.deleteRule);
  const startTunnel = usePortForwardStore((s) => s.startTunnel);
  const stopTunnel = usePortForwardStore((s) => s.stopTunnel);
  const loadActiveTunnels = usePortForwardStore((s) => s.loadActiveTunnels);

  const hosts = useHostsStore((s) => s.hosts);
  const loadHosts = useHostsStore((s) => s.loadHosts);

  const [showForm, setShowForm] = useState(false);
  const [editingRule, setEditingRule] = useState<PortForwardRule | null>(null);
  const [query, setQuery] = useState("");
  const [contextMenu, setContextMenu] = useState<{ rule: PortForwardRule; x: number; y: number } | null>(null);

  useEffect(() => {
    void loadRules();
    void loadActiveTunnels();
    void loadHosts();
  }, [loadRules, loadActiveTunnels, loadHosts]);

  const handleCreate = useCallback(async (rule: Omit<PortForwardRule, "id" | "enabled" | "created_at">) => {
    await createRule(rule);
    setShowForm(false);
  }, [createRule]);

  const handleContextMenu = (e: React.MouseEvent, rule: PortForwardRule) => {
    e.preventDefault();
    setContextMenu({ rule, x: e.clientX, y: e.clientY });
  };

  // Group rules by host
  const hostMap = new Map(hosts.map((h) => [h.id, h]));

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? rules.filter((r) =>
          (r.label?.toLowerCase().includes(q)) ||
          String(r.local_port).includes(q) ||
          String(r.remote_port).includes(q))
      : rules;

    const groups = new Map<string, { host: SavedHost | null; rules: PortForwardRule[] }>();
    for (const rule of filtered) {
      const key = rule.host_id ?? "__standalone__";
      if (!groups.has(key)) {
        groups.set(key, {
          host: rule.host_id ? hostMap.get(rule.host_id) ?? null : null,
          rules: [],
        });
      }
      groups.get(key)!.rules.push(rule);
    }
    return Array.from(groups.values());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rules, hosts, query]);

  // Context menu items
  const buildContextItems = (rule: PortForwardRule): ContextMenuItem[] => {
    const tunnel = activeTunnels.get(rule.id);
    const isActive = tunnel?.status === "Active";

    const items: ContextMenuItem[] = [];

    if (isActive) {
      items.push({
        label: "Stop Tunnel",
        onClick: () => void stopTunnel(rule.id),
      });
    } else {
      items.push({
        label: "Start Tunnel",
        disabled: !rule.host_id,
        onClick: () => { if (rule.host_id) void startTunnel(rule.id, rule.host_id, rule); },
      });
    }

    items.push({
      label: "Edit",
      icon: Pencil,
      separator: true,
      onClick: () => setEditingRule(rule),
    });

    items.push({
      label: "Delete",
      icon: Trash2,
      danger: true,
      onClick: () => void deleteRule(rule.id),
    });

    return items;
  };

  return (
    <>
      <div className="flex flex-col h-full overflow-y-auto bg-bg-base">
        <div className="max-w-4xl w-full mx-auto px-8 py-8 flex flex-col gap-8">

          {/* ── Page title ── */}
          <div>
            <h1 className="text-[length:var(--text-lg)] font-semibold text-text-primary">Tunnels</h1>
            <p className="text-[length:var(--text-xs)] text-text-muted mt-1">Forward local ports to remote services through SSH tunnels for secure database, API, and service access</p>
          </div>

          {/* ── Search bar ── */}
          <div className="relative">
            <Search
              size={15}
              strokeWidth={2}
              className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }}
              placeholder="Search rules..."
              aria-label="Search forwarding rules"
              className={[
                "w-full pl-10 pr-4 py-2.5 rounded-xl text-[length:var(--text-sm)]",
                "bg-bg-surface border border-border text-text-primary placeholder:text-text-muted",
                "outline-none transition-[border-color,box-shadow] duration-[var(--duration-fast)]",
                "focus:border-border-focus focus:ring-2 focus:ring-ring",
              ].join(" ")}
            />
          </div>

          {/* ── Action buttons ── */}
          <div className="flex gap-2">
            <button
              onClick={() => setShowForm(true)}
              className={[
                "flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium uppercase tracking-wide",
                "bg-bg-surface border border-border text-text-secondary",
                "hover:border-border-focus hover:text-text-primary hover:bg-bg-overlay",
                "transition-all duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              ].join(" ")}
              title="New Rule"
            >
              <Plus size={13} strokeWidth={2.2} aria-hidden="true" />
              New Rule
            </button>
          </div>

          {/* ── Rules by host ── */}
          {grouped.length > 0 ? (
            grouped.map((group) => {
              const hostLabel = group.host
                ? (group.host.label || `${group.host.username}@${group.host.host}`)
                : "Standalone";

              return (
                <section key={group.host?.id ?? "__standalone__"} aria-labelledby={`pf-group-${group.host?.id ?? "standalone"}`}>
                  <div className="flex items-center gap-2 mb-3">
                    <Wifi size={12} strokeWidth={2} className="text-text-muted shrink-0" />
                    <h2
                      id={`pf-group-${group.host?.id ?? "standalone"}`}
                      className="text-[length:var(--text-xs)] font-semibold uppercase tracking-widest text-text-muted"
                    >
                      {hostLabel}
                    </h2>
                  </div>

                  <div className="grid grid-cols-3 gap-2.5">
                    {group.rules.map((rule) => {
                      const tunnel = activeTunnels.get(rule.id);
                      const isActive = tunnel?.status === "Active";
                      const isStarting = tunnel?.status === "Starting";
                      const isError = tunnel?.status === "Error";

                      return (
                        <div
                          key={rule.id}
                          onContextMenu={(e) => handleContextMenu(e, rule)}
                          className={[
                            "group flex flex-col gap-2 px-4 py-3 rounded-lg",
                            "bg-bg-surface border cursor-default",
                            "hover:bg-bg-overlay/50 transition-colors duration-[var(--duration-fast)]",
                            isActive ? "border-status-connected/30" :
                            isError ? "border-status-error/30" :
                            "border-border",
                          ].join(" ")}
                        >
                          {/* Top: label + toggle */}
                          <div className="flex items-center gap-2">
                            <span className={[
                              "w-1.5 h-1.5 rounded-full shrink-0",
                              isActive ? "bg-status-connected" :
                              isError ? "bg-status-error" :
                              "bg-bg-muted",
                            ].join(" ")} />
                            <span className="text-[length:var(--text-sm)] font-medium text-text-primary truncate flex-1">
                              {rule.label || `Port ${rule.local_port}`}
                            </span>

                            <button
                              role="switch"
                              aria-checked={isActive}
                              aria-label={isActive ? "Stop tunnel" : "Start tunnel"}
                              disabled={isStarting || (!isActive && !rule.host_id)}
                              onClick={() => {
                                if (isActive) {
                                  void stopTunnel(rule.id);
                                } else if (rule.host_id && !isStarting) {
                                  void startTunnel(rule.id, rule.host_id, rule);
                                }
                              }}
                              className={[
                                "relative w-8 h-[18px] rounded-full shrink-0",
                                "transition-colors duration-[var(--duration-fast)]",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                "disabled:opacity-30",
                                isActive ? "bg-status-connected" : "bg-bg-muted",
                              ].join(" ")}
                            >
                              <span className={[
                                "absolute top-[2px] left-[2px] w-[14px] h-[14px] rounded-full",
                                "transition-transform duration-[var(--duration-fast)]",
                                isActive ? "translate-x-[14px] bg-text-primary" : "translate-x-0 bg-text-secondary",
                              ].join(" ")} />
                            </button>
                          </div>

                          {/* Port mapping + copy */}
                          <div className="flex items-center gap-1.5">
                            <span className="flex items-center gap-1.5 text-[length:var(--text-2xs)] font-mono text-text-muted">
                              <span>:{tunnel?.local_port ?? rule.local_port}</span>
                              <ArrowRight size={9} strokeWidth={2} className="text-text-muted/40" />
                              <span>:{rule.remote_port}</span>
                            </span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                void navigator.clipboard.writeText(`localhost:${tunnel?.local_port ?? rule.local_port}`);
                              }}
                              title="Copy localhost address"
                              aria-label="Copy localhost address"
                              className="p-0.5 rounded text-text-muted/0 group-hover:text-text-muted hover:!text-text-primary transition-all duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <Copy size={10} strokeWidth={2} />
                            </button>
                          </div>

                          {/* Meta: connections, last used */}
                          <div className="flex items-center gap-2 text-[length:var(--text-2xs)] text-text-muted/60">
                            {isActive && tunnel && tunnel.connections > 0 && (
                              <span>{tunnel.connections} conn</span>
                            )}
                            {rule.last_used_at && !isActive && (
                              <span className="flex items-center gap-1">
                                <Clock size={9} strokeWidth={2} />
                                {new Date(rule.last_used_at).toLocaleDateString()}
                              </span>
                            )}
                            {rule.auto_start && (
                              <span className="px-1 py-px rounded bg-bg-subtle text-[8px] uppercase tracking-wide font-semibold">
                                auto
                              </span>
                            )}
                          </div>

                          {/* Error */}
                          {isError && tunnel?.error && (
                            <p className="text-[length:var(--text-2xs)] text-status-error truncate" title={tunnel.error}>
                              {tunnel.error}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })
          ) : rules.length > 0 && query.trim() ? (
            <p className="text-[length:var(--text-sm)] text-text-muted py-8 text-center">
              No rules match &ldquo;{query}&rdquo;
            </p>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <Wifi size={28} strokeWidth={1.2} className="text-text-muted/30" />
              <p className="text-[length:var(--text-sm)] text-text-muted">
                No forwarding rules yet
              </p>
              <p className="text-[length:var(--text-xs)] text-text-muted/60 text-center max-w-xs">
                Forward local ports to remote services through SSH tunnels
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          items={buildContextItems(contextMenu.rule)}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* New rule dialog */}
      {showForm && (
        <RuleDialog
          hosts={hosts}
          onSubmit={handleCreate}
          onCancel={() => setShowForm(false)}
        />
      )}

      {/* Edit rule dialog */}
      {editingRule && (
        <RuleDialog
          hosts={hosts}
          rule={editingRule}
          onSubmit={async (updated) => {
            await usePortForwardStore.getState().updateRule({
              ...editingRule,
              ...updated,
              id: editingRule.id,
              enabled: editingRule.enabled,
              created_at: editingRule.created_at,
            });
            setEditingRule(null);
          }}
          onCancel={() => setEditingRule(null)}
        />
      )}
    </>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

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

const PORT_PRESETS = [
  { label: "PostgreSQL", port: 5432 },
  { label: "MySQL", port: 3306 },
  { label: "Redis", port: 6379 },
  { label: "MongoDB", port: 27017 },
  { label: "HTTP", port: 8080 },
  { label: "HTTPS", port: 443 },
  { label: "K8s API", port: 6443 },
  { label: "Grafana", port: 3000 },
  { label: "Prometheus", port: 9090 },
];

function RuleDialog({
  hosts,
  rule,
  onSubmit,
  onCancel,
}: {
  hosts: SavedHost[];
  rule?: PortForwardRule;
  onSubmit: (rule: Omit<PortForwardRule, "id" | "enabled" | "created_at">) => void;
  onCancel: () => void;
}) {
  const isEdit = !!rule;
  const [hostId, setHostId] = useState(rule?.host_id ?? hosts[0]?.id ?? "");
  const [label, setLabel] = useState(rule?.label ?? "");
  const [description, setDescription] = useState(rule?.description ?? "");
  const [localPort, setLocalPort] = useState(rule ? String(rule.local_port) : "");
  const [remotePort, setRemotePort] = useState(rule ? String(rule.remote_port) : "");
  const [bindAddress, setBindAddress] = useState(rule?.bind_address ?? "127.0.0.1");
  const [autoStart, setAutoStart] = useState(rule?.auto_start ?? false);

  const canSubmit = hostId && localPort && remotePort && Number(localPort) > 0 && Number(remotePort) > 0;

  const applyPreset = (port: number, presetLabel: string) => {
    setLocalPort(String(port));
    setRemotePort(String(port));
    if (!label) setLabel(presetLabel);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit({
      host_id: hostId || null,
      label: label.trim() || null,
      description: description.trim() || null,
      forward_type: "Local",
      bind_address: bindAddress,
      local_port: Number(localPort),
      remote_host: "localhost",
      remote_port: Number(remotePort),
      auto_start: autoStart,
      last_used_at: rule?.last_used_at ?? null,
      total_bytes: rule?.total_bytes ?? 0,
    });
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onCancel]);

  const inputClass =
    "w-full rounded-lg bg-bg-base border border-border px-3 py-2 text-[length:var(--text-sm)] text-text-primary placeholder:text-text-muted outline-none focus:border-border-focus focus:ring-2 focus:ring-ring transition-[border-color,box-shadow] duration-[var(--duration-fast)]";

  const labelClass =
    "block text-[length:var(--text-xs)] font-medium text-text-secondary mb-1";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh]"
      style={{ backgroundColor: "oklch(0 0 0 / 0.5)", backdropFilter: "blur(4px)" }}
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <form
        onSubmit={handleSubmit}
        role="dialog"
        aria-label={isEdit ? "Edit forwarding rule" : "New forwarding rule"}
        className="w-full max-w-lg rounded-xl bg-bg-overlay border border-border shadow-[var(--shadow-lg)] flex flex-col max-h-[84vh] animate-[fadeIn_120ms_var(--ease-expo-out)_both]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border shrink-0">
          <h2 className="text-[length:var(--text-lg)] font-semibold text-text-primary">
            {isEdit ? "Edit Rule" : "New Rule"}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-subtle transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 flex flex-col gap-3.5 overflow-y-auto flex-1 min-h-0">
          <SectionHeader>Connection</SectionHeader>

          {/* Host */}
          <div>
            <label htmlFor="pf-host" className={labelClass}>Host</label>
            {hosts.length > 0 ? (
              <CustomSelect
                id="pf-host"
                value={hostId}
                onChange={setHostId}
                options={hosts.map((h) => ({
                  value: h.id,
                  label: h.label || `${h.username}@${h.host}`,
                }))}
              />
            ) : (
              <p className="text-[length:var(--text-xs)] text-text-muted py-1.5">
                No saved hosts. Add a host first.
              </p>
            )}
          </div>

          {/* Label */}
          <div>
            <label htmlFor="pf-label" className={labelClass}>
              Label
              <span className="ml-1 text-text-muted font-normal">(optional)</span>
            </label>
            <input
              id="pf-label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="My Database"
              className={inputClass}
            />
          </div>

          {/* Description */}
          <div>
            <label htmlFor="pf-desc" className={labelClass}>
              Description
              <span className="ml-1 text-text-muted font-normal">(optional)</span>
            </label>
            <textarea
              id="pf-desc"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Production read replica for analytics..."
              className={`${inputClass} resize-none`}
            />
          </div>

          <SectionHeader>Ports</SectionHeader>

          {/* Preset buttons */}
          {!isEdit && (
            <div className="flex flex-wrap gap-1.5">
              {PORT_PRESETS.map((preset) => (
                <button
                  key={preset.port}
                  type="button"
                  onClick={() => applyPreset(preset.port, preset.label)}
                  className={[
                    "px-2 py-1 rounded-md text-[length:var(--text-2xs)] font-medium",
                    "bg-bg-base border border-border text-text-muted",
                    "hover:border-border-focus hover:text-text-secondary hover:bg-bg-subtle",
                    "transition-all duration-[var(--duration-fast)]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  ].join(" ")}
                >
                  {preset.label} ({preset.port})
                </button>
              ))}
            </div>
          )}

          {/* Port inputs */}
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <label htmlFor="pf-local-port" className={labelClass}>Local Port</label>
              <input
                id="pf-local-port"
                type="number"
                value={localPort}
                onChange={(e) => setLocalPort(e.target.value)}
                placeholder="5432"
                min={1}
                max={65535}
                className={`${inputClass} font-mono`}
              />
            </div>

            <ArrowRight size={14} strokeWidth={2} className="text-text-muted/40 mb-3 shrink-0" />

            <div className="flex-1">
              <label htmlFor="pf-remote-port" className={labelClass}>Remote Port</label>
              <input
                id="pf-remote-port"
                type="number"
                value={remotePort}
                onChange={(e) => setRemotePort(e.target.value)}
                placeholder="5432"
                min={1}
                max={65535}
                className={`${inputClass} font-mono`}
              />
            </div>
          </div>

          <SectionHeader>Options</SectionHeader>

          {/* Bind address */}
          <div>
            <label htmlFor="pf-bind" className={labelClass}>Bind Address</label>
            <CustomSelect
              id="pf-bind"
              value={bindAddress}
              onChange={setBindAddress}
              options={[
                { value: "127.0.0.1", label: "127.0.0.1 (local only)" },
                { value: "0.0.0.0", label: "0.0.0.0 (all interfaces)" },
              ]}
            />
          </div>

          {/* Auto-start */}
          <div className="flex items-center justify-between gap-3">
            <div>
              <span className={labelClass}>Auto-start</span>
              <p className="text-[length:var(--text-2xs)] text-text-muted">Start tunnel when host connects</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={autoStart}
              onClick={() => setAutoStart(!autoStart)}
              className={[
                "relative w-9 h-5 rounded-full shrink-0",
                "transition-colors duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                autoStart ? "bg-accent" : "bg-bg-muted",
              ].join(" ")}
            >
              <span className={[
                "absolute top-0.5 left-0.5 w-4 h-4 rounded-full",
                "transition-transform duration-[var(--duration-fast)]",
                autoStart ? "translate-x-4 bg-text-primary" : "translate-x-0 bg-text-secondary",
              ].join(" ")} />
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 pb-5 pt-3 flex items-center justify-end gap-2 border-t border-border shrink-0">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-[length:var(--text-sm)] text-text-secondary hover:text-text-primary rounded-lg transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="px-4 py-2 text-[length:var(--text-sm)] font-medium text-text-inverse bg-accent hover:bg-accent-hover disabled:opacity-50 rounded-lg transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {isEdit ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
