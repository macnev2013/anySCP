import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { Search, Plus, ArrowLeft, FolderPlus, Import, Cloud, Trash2, FolderOpen, Pencil, Copy } from "lucide-react";
import { ContextMenu } from "../shared/ContextMenu";
import { ImportSshConfigModal } from "./ImportSshConfigModal";
import { S3ConnectDialog } from "../s3/S3ConnectDialog";
import { useHostsStore } from "../../stores/hosts-store";
import { useGroupsStore } from "../../stores/groups-store";
import { useSessionStore } from "../../stores/session-store";
import { useUiStore } from "../../stores/ui-store";
import { useTabStore } from "../../stores/tab-store";
import { useSftpStore } from "../../stores/sftp-store";
import { useS3Store } from "../../stores/s3-store";
import type { SavedHost, HostGroup, RecentConnection, S3Connection } from "../../types";
import { HostCard } from "./HostCard";
import { GroupCard } from "./GroupCard";
import { GroupDeleteDialog } from "./GroupDeleteDialog";
import { GroupModal } from "./GroupModal";
import { ConnectionDialog } from "./ConnectionDialog";
import { RecentConnections } from "./RecentConnections";

// ─── Component ───────────────────────────────────────────────────────────────

export function HostsDashboard() {
  const { hosts, loadHosts, recentConnections, loadRecent, saveHost, deleteHost } =
    useHostsStore();
  const { groups, loadGroups, createGroup, deleteGroup } = useGroupsStore();
  const setEditingHostId = useUiStore((s) => s.setEditingHostId);

  const [query, setQuery] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);

  // Group modal state
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [s3DialogOpen, setS3DialogOpen] = useState(false);

  // Group delete dialog state
  const [deletingGroup, setDeletingGroup] = useState<{
    group: HostGroup;
    hostCount: number;
  } | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);

  // S3 connections
  const [s3Connections, setS3Connections] = useState<S3Connection[]>([]);

  const loadS3Connections = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const conns = await invoke<S3Connection[]>("s3_list_connections");
      setS3Connections(conns);
    } catch { /* best-effort */ }
  };

  const [s3ContextMenu, setS3ContextMenu] = useState<{ conn: S3Connection; x: number; y: number } | null>(null);
  const [editingS3Connection, setEditingS3Connection] = useState<S3Connection | null>(null);

  const handleS3Connect = async (conn: S3Connection) => {
    setConnectingHost({ label: conn.label, error: null, retry: () => void handleS3Connect(conn) });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("s3_reconnect", { id: conn.id });
      useS3Store.getState().openSession(conn.id, conn.label);
      if (conn.bucket) {
        useS3Store.getState().setCurrentBucket(conn.id, conn.bucket);
      }
      setConnectingHost(null);
      useTabStore.getState().addTab({ type: "s3", id: conn.id, label: conn.label });
    } catch (err) {
      const msg = err && typeof err === "object" && "message" in err
        ? String((err as { message: string }).message)
        : "S3 connection failed";
      setConnectingHost({ label: conn.label, error: msg, retry: () => void handleS3Connect(conn) });
    }
  };

  const handleS3Delete = async (conn: S3Connection) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("s3_delete_connection", { id: conn.id });
      setS3Connections((prev) => prev.filter((c) => c.id !== conn.id));
    } catch { /* best-effort */ }
  };

  // Connection dialog state
  const [connectingHost, setConnectingHost] = useState<{ label: string; error: string | null; retry: (() => void) | null } | null>(null);

  // Load data on mount
  useEffect(() => {
    void loadHosts();
    void loadGroups();
    void loadRecent();
    void loadS3Connections();
  }, [loadHosts, loadGroups, loadRecent]);


  // ─── Derived data ─────────────────────────────────────────────────────────

  const hostCountByGroup = useMemo<Record<string, number>>(() => {
    const counts: Record<string, number> = {};
    for (const host of hosts) {
      if (host.group_id) {
        counts[host.group_id] = (counts[host.group_id] ?? 0) + 1;
      }
    }
    for (const conn of s3Connections) {
      if (conn.group_id) {
        counts[conn.group_id] = (counts[conn.group_id] ?? 0) + 1;
      }
    }
    return counts;
  }, [hosts, s3Connections]);

  const filteredHosts = useMemo<SavedHost[]>(() => {
    let result = hosts;

    // Group filter
    if (selectedGroupId !== null) {
      result = result.filter((h) => h.group_id === selectedGroupId);
    }

    // Search filter
    const q = query.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (h) =>
          h.host.toLowerCase().includes(q) ||
          h.label.toLowerCase().includes(q) ||
          h.username.toLowerCase().includes(q),
      );
    }

    return result;
  }, [hosts, selectedGroupId, query]);

  const filteredS3 = useMemo<S3Connection[]>(() => {
    let result = s3Connections;

    // Group filter
    if (selectedGroupId !== null) {
      result = result.filter((c) => c.group_id === selectedGroupId);
    }

    // Search filter
    const q = query.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (c) =>
          c.label.toLowerCase().includes(q) ||
          c.provider.toLowerCase().includes(q) ||
          (c.bucket?.toLowerCase().includes(q) ?? false),
      );
    }

    return result;
  }, [s3Connections, selectedGroupId, query]);

  // ─── Connect handlers ──────────────────────────────────────────────────────

  // Connect directly using saved credentials from the vault.
  // If connection fails (e.g., no saved credential), the error shows in the terminal overlay.
  const connectToHost = useCallback(
    async (host: SavedHost) => {
      const label = host.label || `${host.username}@${host.host}`;
      setConnectingHost({ label, error: null, retry: () => void connectToHost(host) });
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const addSession = useSessionStore.getState().addSession;
        const sessionId = await invoke<string>("connect_saved_host", { hostId: host.id });
        const hostLabel = host.label || `${host.username}@${host.host}`;
        addSession(sessionId, {
          host: host.host,
          port: host.port,
          username: host.username,
          label: host.label || undefined,
          auth_method: { type: "password", password: "" },
        });
        void useHostsStore.getState().recordConnection(host.id);
        setConnectingHost(null);
        useTabStore.getState().addTab({ type: "terminal", id: sessionId, label: hostLabel });
      } catch (err) {
        const msg = err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : "Connection failed. Check host, port, and credentials.";
        setConnectingHost({ label, error: msg, retry: () => void connectToHost(host) });
      }
    },
    [],
  );

  const handleRecentConnect = useCallback(
    async (conn: RecentConnection) => {
      const label = conn.host_label || `${conn.username}@${conn.host}`;
      setConnectingHost({ label, error: null, retry: () => void handleRecentConnect(conn) });
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const addSession = useSessionStore.getState().addSession;
        const sessionId = await invoke<string>("connect_saved_host", { hostId: conn.host_id });
        const connLabel = conn.host_label || `${conn.username}@${conn.host}`;
        addSession(sessionId, {
          host: conn.host,
          port: conn.port,
          username: conn.username,
          label: conn.host_label || undefined,
          auth_method: { type: "password", password: "" },
        });
        void useHostsStore.getState().recordConnection(conn.host_id);
        setConnectingHost(null);
        useTabStore.getState().addTab({ type: "terminal", id: sessionId, label: connLabel });
      } catch (err) {
        const msg = err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : "Connection failed.";
        setConnectingHost({ label, error: msg, retry: () => void handleRecentConnect(conn) });
      }
    },
    [],
  );

  // Explore: connect SSH + open SFTP + switch to Files page
  // NOTE: We don't call addSession — the SSH connection lives in Rust's SshManager
  // but we don't need a terminal pane for SFTP-only connections.
  const exploreHost = useCallback(
    async (host: SavedHost) => {
      const label = host.label || `${host.username}@${host.host}`;
      setConnectingHost({ label, error: null, retry: () => void exploreHost(host) });
      try {
        const { invoke } = await import("@tauri-apps/api/core");

        const sessionId = await invoke<string>("connect_saved_host_no_pty", { hostId: host.id });
        const sftpSessionId = await invoke<string>("sftp_open", { sessionId });
        useSftpStore.getState().openSession(sftpSessionId, sessionId, label);

        setConnectingHost(null);
        useTabStore.getState().addTab({ type: "sftp", id: sftpSessionId, label });
      } catch (err) {
        const msg = err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : "Connection failed.";
        setConnectingHost({ label, error: msg, retry: () => void exploreHost(host) });
      }
    },
    [],
  );

  // ─── Host action handlers ──────────────────────────────────────────────────

  const handleDeleteHost = useCallback(
    async (id: string) => {
      await deleteHost(id);
      // deleteHost already reloads the hosts list in the store
    },
    [deleteHost],
  );

  const handleDuplicateHost = useCallback(
    async (host: SavedHost) => {
      const now = new Date().toISOString();
      const duplicate: SavedHost = {
        ...host,
        id: crypto.randomUUID(),
        label: `${host.label || host.host} (copy)`,
        created_at: now,
        updated_at: now,
        last_connected_at: null,
        connection_count: null,
      };
      await saveHost(duplicate);
      // saveHost already reloads the hosts list in the store
    },
    [saveHost],
  );

  // ─── Group handlers ────────────────────────────────────────────────────────

  const handleGroupSelect = (groupId: string) => {
    setSelectedGroupId((prev) => (prev === groupId ? null : groupId));
  };

  const handleGroupDeleteRequest = useCallback(
    (groupId: string) => {
      const group = groups.find((g) => g.id === groupId);
      if (!group) return;
      const hostCount = hostCountByGroup[groupId] ?? 0;
      setDeletingGroup({ group, hostCount });
    },
    [groups, hostCountByGroup],
  );

  const handleGroupDeleteConfirm = useCallback(
    async (deleteHosts: boolean) => {
      if (!deletingGroup) return;
      const { group } = deletingGroup;

      try {
        if (deleteHosts) {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("delete_group_with_hosts", { id: group.id });
          // Reload both hosts and groups
          await Promise.all([loadHosts(), loadGroups()]);
        } else {
          await deleteGroup(group.id);
          // deleteGroup reloads groups; reload hosts too since their group_id may change
          await loadHosts();
        }
      } finally {
        // If the deleted group was selected, clear the filter
        if (selectedGroupId === group.id) {
          setSelectedGroupId(null);
        }
        setDeletingGroup(null);
      }
    },
    [deletingGroup, deleteGroup, loadHosts, loadGroups, selectedGroupId],
  );

  const handleCreateGroup = async (data: { name: string; color: string; icon: string }) => {
    const now = new Date().toISOString();
    await createGroup({
      id: crypto.randomUUID(),
      name: data.name,
      color: data.color,
      icon: data.icon,
      sort_order: groups.length,
      default_username: null,
      created_at: now,
      updated_at: now,
    });
    setGroupModalOpen(false);
  };

  // ─── Active group label (breadcrumb) ──────────────────────────────────────

  const activeGroup = selectedGroupId
    ? groups.find((g) => g.id === selectedGroupId)
    : null;

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="flex flex-col h-full overflow-y-auto bg-bg-base">
        <div className="max-w-4xl w-full mx-auto px-8 py-8 flex flex-col gap-8">

          {/* ── Page title ── */}
          <div>
            <h1 className="text-[length:var(--text-lg)] font-semibold text-text-primary">Hosts</h1>
            <p className="text-[length:var(--text-xs)] text-text-muted mt-1">Manage your saved servers, organize them into groups, and connect with one click</p>
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
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQuery("");
              }}
              placeholder="Search hosts..."
              aria-label="Search hosts"
              className={[
                "w-full pl-10 pr-4 py-2.5 rounded-xl text-[length:var(--text-sm)]",
                "bg-bg-surface border border-border text-text-primary placeholder:text-text-muted",
                "outline-none transition-[border-color,box-shadow] duration-[var(--duration-fast)]",
                "focus:border-border-focus focus:ring-2 focus:ring-ring",
              ].join(" ")}
            />
          </div>

          {/* ── Recent connections ── */}
          {recentConnections.length > 0 && (
            <RecentConnections
              connections={recentConnections}
              onConnect={(conn) => void handleRecentConnect(conn)}
            />
          )}

          {/* ── Action buttons ── */}
          <div className="flex gap-2">
            <button
              onClick={() => setEditingHostId("__new__")}
              className={[
                "flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium uppercase tracking-wide",
                "bg-bg-surface border border-border text-text-secondary",
                "hover:border-border-focus hover:text-text-primary hover:bg-bg-overlay",
                "transition-all duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              ].join(" ")}
              title="New Server (Cmd+T)"
            >
              <Plus size={13} strokeWidth={2.2} aria-hidden="true" />
              New Server
            </button>

            <button
              onClick={() => setS3DialogOpen(true)}
              className={[
                "flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium uppercase tracking-wide",
                "bg-bg-surface border border-border text-text-secondary",
                "hover:border-border-focus hover:text-text-primary hover:bg-bg-overlay",
                "transition-all duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              ].join(" ")}
              title="New S3 Connection"
            >
              <Cloud size={13} strokeWidth={2} aria-hidden="true" />
              New S3
            </button>

            <button
              onClick={() => setGroupModalOpen(true)}
              className={[
                "flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium uppercase tracking-wide",
                "bg-bg-surface border border-border text-text-secondary",
                "hover:border-border-focus hover:text-text-primary hover:bg-bg-overlay",
                "transition-all duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              ].join(" ")}
              title="New Group"
            >
              <FolderPlus size={13} strokeWidth={2} aria-hidden="true" />
              New Group
            </button>

            <button
              onClick={() => setImportModalOpen(true)}
              className={[
                "flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium uppercase tracking-wide",
                "bg-bg-surface border border-border text-text-secondary",
                "hover:border-border-focus hover:text-text-primary hover:bg-bg-overlay",
                "transition-all duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              ].join(" ")}
              title="Import from SSH Config"
            >
              <Import size={13} strokeWidth={2} aria-hidden="true" />
              Import
            </button>
          </div>

          {/* ── Groups section ── */}
          {groups.length > 0 && (
            <section aria-labelledby="groups-heading">
              <h2
                id="groups-heading"
                className="text-[length:var(--text-xs)] font-semibold uppercase tracking-widest text-text-muted mb-3"
              >
                Groups
              </h2>
              <div className="grid grid-cols-3 gap-2.5">
                {groups.map((group) => (
                  <GroupCard
                    key={group.id}
                    group={group}
                    hostCount={hostCountByGroup[group.id] ?? 0}
                    isSelected={selectedGroupId === group.id}
                    onSelect={handleGroupSelect}
                    onDelete={handleGroupDeleteRequest}
                  />
                ))}
              </div>
            </section>
          )}

          {/* ── Hosts section ── */}
          <section aria-labelledby="hosts-heading">
            <div className="flex items-center gap-3 mb-3">
              {/* Breadcrumb back button when a group is selected */}
              {activeGroup && (
                <button
                  onClick={() => setSelectedGroupId(null)}
                  className={[
                    "flex items-center gap-1.5 text-[length:var(--text-xs)] text-text-muted",
                    "hover:text-text-secondary transition-colors duration-[var(--duration-fast)]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded",
                  ].join(" ")}
                  aria-label="Back to all hosts"
                >
                  <ArrowLeft size={12} strokeWidth={2.2} aria-hidden="true" />
                  All Hosts
                </button>
              )}

              <h2
                id="hosts-heading"
                className="text-[length:var(--text-xs)] font-semibold uppercase tracking-widest text-text-muted"
              >
                {activeGroup ? activeGroup.name : "Hosts"}
              </h2>
            </div>

            {/* Host grid or empty state */}
            {filteredHosts.length > 0 ? (
              <div className="grid grid-cols-3 gap-2.5">
                {filteredHosts.map((host) => (
                  <HostCard
                    key={host.id}
                    host={host}
                    onConnect={(h) => void connectToHost(h)}
                    onExplore={(h) => void exploreHost(h)}
                    onEdit={setEditingHostId}
                    onDelete={(id) => void handleDeleteHost(id)}
                    onDuplicate={(h) => void handleDuplicateHost(h)}
                  />
                ))}
              </div>
            ) : (
              <EmptyHostsState
                query={query}
                hasHosts={hosts.length > 0}
                groupFiltered={selectedGroupId !== null}
              />
            )}
          </section>

          {/* ── S3 connections section ── */}
          {filteredS3.length > 0 && (
            <section aria-labelledby="s3-heading">
              <h2
                id="s3-heading"
                className="text-[length:var(--text-xs)] font-semibold uppercase tracking-widest text-text-muted mb-3"
              >
                Cloud Storage
              </h2>
              <div className="grid grid-cols-3 gap-2.5">
                {filteredS3.map((conn) => (
                    <button
                      key={conn.id}
                      onClick={() => void handleS3Connect(conn)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setS3ContextMenu({ conn, x: e.clientX, y: e.clientY });
                      }}
                      className={[
                        "flex flex-col gap-2 px-4 py-3 rounded-lg text-left",
                        "bg-bg-surface border border-border",
                        "hover:bg-bg-overlay/50 hover:border-border-focus",
                        "transition-all duration-[var(--duration-fast)]",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      ].join(" ")}
                    >
                      <div className="flex items-center gap-2.5">
                        <div
                          className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 font-bold text-[length:var(--text-xs)]"
                          style={{
                            background: conn.color ?? "var(--color-bg-muted)",
                            color: conn.color ? "var(--color-text-inverse)" : "var(--color-text-muted)",
                          }}
                        >
                          <Cloud size={14} strokeWidth={2} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="text-[length:var(--text-sm)] font-medium text-text-primary truncate">
                              {conn.label}
                            </p>
                            {conn.environment && (
                              <span className={[
                                "inline-flex items-center px-1.5 py-px rounded text-[8px] font-semibold tracking-wide leading-none shrink-0 uppercase",
                                conn.environment === "production" ? "bg-status-error/15 text-status-error" :
                                conn.environment === "staging" ? "bg-status-connecting/15 text-status-connecting" :
                                "bg-accent/15 text-accent",
                              ].join(" ")}>
                                {conn.environment}
                              </span>
                            )}
                          </div>
                          <p className="text-[length:var(--text-2xs)] text-text-muted truncate">
                            {conn.provider} · {conn.region}{conn.bucket ? ` · ${conn.bucket}` : ""}
                          </p>
                        </div>
                      </div>
                    </button>
                  ))}
              </div>
            </section>
          )}
        </div>
      </div>

      {/* ── Group create modal ── */}
      <GroupModal
        open={groupModalOpen}
        onClose={() => setGroupModalOpen(false)}
        onSave={handleCreateGroup}
      />

      {/* ── Group delete confirmation dialog ── */}
      {deletingGroup && (
        <GroupDeleteDialog
          group={deletingGroup.group}
          hostCount={deletingGroup.hostCount}
          onConfirm={(deleteHosts) => void handleGroupDeleteConfirm(deleteHosts)}
          onCancel={() => setDeletingGroup(null)}
        />
      )}

      {s3ContextMenu && (
        <ContextMenu
          items={[
            {
              label: "Explore",
              icon: FolderOpen,
              onClick: () => void handleS3Connect(s3ContextMenu.conn),
            },
            {
              label: "Edit",
              icon: Pencil,
              onClick: () => setEditingS3Connection(s3ContextMenu.conn),
            },
            {
              label: "Duplicate",
              icon: Copy,
              separator: true,
              onClick: () => {
                void (async () => {
                  try {
                    const { invoke } = await import("@tauri-apps/api/core");
                    await invoke("s3_save_connection", {
                      label: `${s3ContextMenu.conn.label} (copy)`,
                      provider: s3ContextMenu.conn.provider,
                      bucketName: s3ContextMenu.conn.bucket ?? "",
                      region: s3ContextMenu.conn.region,
                      endpoint: s3ContextMenu.conn.endpoint,
                      accessKey: "",
                      secretKey: "",
                      pathStyle: s3ContextMenu.conn.path_style,
                      groupId: s3ContextMenu.conn.group_id,
                      color: s3ContextMenu.conn.color,
                      environment: s3ContextMenu.conn.environment,
                      notes: s3ContextMenu.conn.notes,
                    });
                  } catch { /* credential-less copy saved to DB */ }
                  await loadS3Connections();
                })();
              },
            },
            {
              label: "Delete",
              icon: Trash2,
              separator: true,
              danger: true,
              onClick: () => void handleS3Delete(s3ContextMenu.conn),
            },
          ]}
          position={{ x: s3ContextMenu.x, y: s3ContextMenu.y }}
          onClose={() => setS3ContextMenu(null)}
        />
      )}

      {s3DialogOpen && (
        <S3ConnectDialog onClose={() => { setS3DialogOpen(false); void loadS3Connections(); }} />
      )}

      {editingS3Connection && (
        <S3ConnectDialog
          editConnection={editingS3Connection}
          onClose={() => { setEditingS3Connection(null); void loadS3Connections(); }}
        />
      )}

      {importModalOpen && (
        <ImportSshConfigModal
          onClose={() => setImportModalOpen(false)}
          onImported={() => void loadHosts()}
        />
      )}

      {connectingHost && (
        <ConnectionDialog
          label={connectingHost.label}
          error={connectingHost.error}
          onClose={() => setConnectingHost(null)}
          onRetry={connectingHost.retry ?? undefined}
        />
      )}
    </>
  );
}

// ─── Empty states ─────────────────────────────────────────────────────────────

interface EmptyHostsStateProps {
  query: string;
  hasHosts: boolean;
  groupFiltered: boolean;
}

function EmptyHostsState({ query, hasHosts, groupFiltered }: EmptyHostsStateProps) {
  if (query.trim()) {
    return (
      <p className="text-[length:var(--text-sm)] text-text-muted py-8 text-center">
        No hosts match &ldquo;{query}&rdquo;
      </p>
    );
  }

  if (groupFiltered) {
    return (
      <p className="text-[length:var(--text-sm)] text-text-muted py-8 text-center">
        No hosts in this group yet.
      </p>
    );
  }

  if (!hasHosts) {
    return (
      <p className="text-[length:var(--text-sm)] text-text-muted py-8 text-center">
        No saved hosts yet. Connect to a server to save it here.
      </p>
    );
  }

  return null;
}
