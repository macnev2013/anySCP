import { useState, useEffect } from "react";
import { Plus, Cloud, Search, Trash2, FolderOpen, Copy, Pencil } from "lucide-react";
import type { S3Connection } from "../../types";
import { useS3Store } from "../../stores/s3-store";
import { S3Browser } from "./S3Browser";
import { S3ConnectDialog } from "./S3ConnectDialog";
import { ContextMenu } from "../shared/ContextMenu";
import type { ContextMenuItem } from "../shared/ContextMenu";
import type { S3Session } from "../../stores/s3-store";

export function S3Page() {
  const sessions = useS3Store((s) => s.sessions);
  const activeS3SessionId = useS3Store((s) => s.activeS3SessionId);
  const setActiveS3Session = useS3Store((s) => s.setActiveS3Session);
  const closeSession = useS3Store((s) => s.closeSession);
  const [showConnect, setShowConnect] = useState(false);
  const [editingConnection, setEditingConnection] = useState<S3Connection | null>(null);
  const [query, setQuery] = useState("");
  const [savedConnections, setSavedConnections] = useState<S3Connection[]>([]);
  const [contextMenu, setContextMenu] = useState<{ session: S3Session; x: number; y: number } | null>(null);
  const [savedContextMenu, setSavedContextMenu] = useState<{ conn: S3Connection; x: number; y: number } | null>(null);

  // Load saved connections on mount
  useEffect(() => {
    void loadSavedConnections();
  }, []);

  const loadSavedConnections = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const conns = await invoke<S3Connection[]>("s3_list_connections");
      setSavedConnections(conns);
    } catch { /* best-effort */ }
  };

  const handleReconnect = async (conn: S3Connection) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("s3_reconnect", { id: conn.id });
      useS3Store.getState().openSession(conn.id, conn.label);
      if (conn.bucket) {
        useS3Store.getState().setCurrentBucket(conn.id, conn.bucket);
      }
    } catch (err) {
      console.error("Reconnect failed:", err);
    }
  };

  const handleDuplicate = async (conn: S3Connection) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      // Reconnect original to get credentials, then save a copy
      // Simpler: just create a new DB entry (credentials won't be copied — user will need to re-enter)
      await invoke("s3_connect", {
        label: `${conn.label} (copy)`,
        provider: conn.provider,
        bucketName: conn.bucket ?? "",
        region: conn.region,
        endpoint: conn.endpoint,
        accessKey: "", // Will need credentials on reconnect
        secretKey: "",
        pathStyle: conn.path_style,
        color: conn.color,
        environment: conn.environment,
        notes: conn.notes,
      });
      await loadSavedConnections();
    } catch {
      // If it fails because of empty credentials, the connection is still saved to DB
      await loadSavedConnections();
    }
  };

  const handleDeleteSaved = async (conn: S3Connection) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("s3_delete_connection", { id: conn.id });
      setSavedConnections((prev) => prev.filter((c) => c.id !== conn.id));
    } catch { /* best-effort */ }
  };

  const activeSession = activeS3SessionId ? sessions.get(activeS3SessionId) : null;

  // If actively browsing, show the browser
  if (activeSession) {
    return <S3Browser sessionId={activeSession.sessionId} />;
  }

  const sessionList = Array.from(sessions.values());
  const filtered = query.trim()
    ? sessionList.filter((s) =>
        s.label.toLowerCase().includes(query.trim().toLowerCase()) ||
        (s.currentBucket?.toLowerCase().includes(query.trim().toLowerCase()) ?? false))
    : sessionList;

  const handleContextMenu = (e: React.MouseEvent, session: S3Session) => {
    e.preventDefault();
    setContextMenu({ session, x: e.clientX, y: e.clientY });
  };

  const buildContextItems = (session: S3Session): ContextMenuItem[] => {
    const conn = savedConnections.find((c) => c.id === session.sessionId);
    return [
      {
        label: "Open",
        icon: FolderOpen,
        onClick: () => setActiveS3Session(session.sessionId),
      },
      ...(conn ? [{
        label: "Duplicate",
        icon: Copy,
        separator: true as const,
        onClick: () => void handleDuplicate(conn),
      }] : []),
      {
        label: "Disconnect",
        icon: Trash2,
        separator: !conn ? true as const : undefined,
        danger: true as const,
        onClick: () => {
          void (async () => {
            try {
              const { invoke } = await import("@tauri-apps/api/core");
              await invoke("s3_disconnect", { s3SessionId: session.sessionId });
            } catch { /* best-effort */ }
            closeSession(session.sessionId);
          })();
        },
      },
    ];
  };

  return (
    <>
      <div className="flex flex-col h-full overflow-y-auto bg-bg-base">
        <div className="max-w-4xl w-full mx-auto px-8 py-8 flex flex-col gap-8">

          {/* Page title */}
          <div>
            <h1 className="text-[length:var(--text-lg)] font-semibold text-text-primary">Cloud Storage</h1>
            <p className="text-[length:var(--text-xs)] text-text-muted mt-1">
              Browse and manage files in S3 buckets and S3-compatible storage services like MinIO, R2, and Wasabi
            </p>
          </div>

          {/* Search */}
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
              placeholder="Search connections..."
              aria-label="Search S3 connections"
              className={[
                "w-full pl-10 pr-4 py-2.5 rounded-xl text-[length:var(--text-sm)]",
                "bg-bg-surface border border-border text-text-primary placeholder:text-text-muted",
                "outline-none transition-[border-color,box-shadow] duration-[var(--duration-fast)]",
                "focus:border-border-focus focus:ring-2 focus:ring-ring",
              ].join(" ")}
            />
          </div>

          {/* Action buttons */}
          <div className="flex gap-2">
            <button
              onClick={() => setShowConnect(true)}
              className={[
                "flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium uppercase tracking-wide",
                "bg-bg-surface border border-border text-text-secondary",
                "hover:border-border-focus hover:text-text-primary hover:bg-bg-overlay",
                "transition-all duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              ].join(" ")}
            >
              <Plus size={13} strokeWidth={2.2} />
              New Connection
            </button>
          </div>

          {/* Saved connections */}
          {savedConnections.filter((c) => !sessions.has(c.id)).length > 0 && (
            <section>
              <h2 className="text-[length:var(--text-xs)] font-semibold uppercase tracking-widest text-text-muted mb-3">
                Saved
              </h2>
              <div className="grid grid-cols-3 gap-2.5">
                {savedConnections
                  .filter((c) => !sessions.has(c.id))
                  .filter((c) => !query.trim() || c.label.toLowerCase().includes(query.trim().toLowerCase()))
                  .map((conn) => (
                    <S3ConnectionCard
                      key={conn.id}
                      conn={conn}
                      onClick={() => void handleReconnect(conn)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setSavedContextMenu({ conn, x: e.clientX, y: e.clientY });
                      }}
                    />
                  ))}
              </div>
            </section>
          )}

          {/* Active connections */}
          <section>
            <h2 className="text-[length:var(--text-xs)] font-semibold uppercase tracking-widest text-text-muted mb-3">
              Active
            </h2>

            {filtered.length > 0 ? (
              <div className="grid grid-cols-3 gap-2.5">
                {filtered.map((session) => {
                  const conn = savedConnections.find((c) => c.id === session.sessionId);
                  return (
                    <button
                      key={session.sessionId}
                      onClick={() => setActiveS3Session(session.sessionId)}
                      onContextMenu={(e) => handleContextMenu(e, session)}
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
                          className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 text-text-inverse font-bold text-[length:var(--text-xs)]"
                          style={{ background: conn?.color ?? "var(--color-accent)" }}
                        >
                          {session.label.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="text-[length:var(--text-sm)] font-medium text-text-primary truncate">
                              {session.label}
                            </p>
                            {conn?.environment && (
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
                            {session.currentBucket ?? conn?.bucket ?? conn?.provider}
                          </p>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : sessionList.length > 0 && query.trim() ? (
              <p className="text-[length:var(--text-sm)] text-text-muted py-8 text-center">
                No connections match &ldquo;{query}&rdquo;
              </p>
            ) : (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <Cloud size={28} strokeWidth={1.2} className="text-text-muted/30" />
                <p className="text-[length:var(--text-sm)] text-text-muted">
                  No S3 connections
                </p>
                <p className="text-[length:var(--text-xs)] text-text-muted/60 text-center max-w-xs">
                  Connect to Amazon S3, MinIO, Cloudflare R2, or any S3-compatible storage
                </p>
              </div>
            )}
          </section>
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          items={buildContextItems(contextMenu.session)}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Saved connection context menu */}
      {savedContextMenu && (
        <ContextMenu
          items={[
            {
              label: "Connect",
              icon: FolderOpen,
              onClick: () => void handleReconnect(savedContextMenu.conn),
            },
            {
              label: "Edit",
              icon: Pencil,
              onClick: () => setEditingConnection(savedContextMenu.conn),
            },
            {
              label: "Duplicate",
              icon: Copy,
              separator: true,
              onClick: () => void handleDuplicate(savedContextMenu.conn),
            },
            {
              label: "Delete",
              icon: Trash2,
              danger: true,
              onClick: () => void handleDeleteSaved(savedContextMenu.conn),
            },
          ]}
          position={{ x: savedContextMenu.x, y: savedContextMenu.y }}
          onClose={() => setSavedContextMenu(null)}
        />
      )}

      {/* Connect dialog */}
      {showConnect && (
        <S3ConnectDialog onClose={() => { setShowConnect(false); void loadSavedConnections(); }} />
      )}

      {/* Edit dialog */}
      {editingConnection && (
        <S3ConnectDialog
          editConnection={editingConnection}
          onClose={() => { setEditingConnection(null); void loadSavedConnections(); }}
        />
      )}
    </>
  );
}

// ─── Card component ──────────────────────────────────────────────────────────

function S3ConnectionCard({
  conn,
  onClick,
  onContextMenu,
}: {
  conn: S3Connection;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const initial = conn.label.charAt(0).toUpperCase();
  const bgColor = conn.color ?? "var(--color-bg-muted)";
  const textColor = conn.color ? "var(--color-text-inverse)" : "var(--color-text-muted)";

  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
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
          style={{ background: bgColor, color: textColor }}
        >
          {initial}
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
  );
}
