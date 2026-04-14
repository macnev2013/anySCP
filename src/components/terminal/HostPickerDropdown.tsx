import { useState, useEffect, useRef, useCallback } from "react";
import { Search, Plus, Clock, Server, Monitor } from "lucide-react";
import { useHostsStore } from "../../stores/hosts-store";
import { useSessionStore } from "../../stores/session-store";
import { useTabStore } from "../../stores/tab-store";
import { useUiStore } from "../../stores/ui-store";
import { startBuffering } from "../../stores/output-buffer";
import { NEW_HOST_ID } from "../dashboard/HostEditModal";
import type { SavedHost, RecentConnection } from "../../types";

interface HostPickerDropdownProps {
  pendingId: string;
}

export function HostPickerDropdown({ pendingId }: HostPickerDropdownProps) {
  const [query, setQuery] = useState("");
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const hosts = useHostsStore((s) => s.hosts);
  const recentConnections = useHostsStore((s) => s.recentConnections);
  const loadHosts = useHostsStore((s) => s.loadHosts);
  const loadRecent = useHostsStore((s) => s.loadRecent);

  useEffect(() => {
    loadHosts();
    loadRecent();
  }, [loadHosts, loadRecent]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const connectToHost = useCallback(
    async (host: SavedHost) => {
      if (connecting) return;
      setConnecting(host.id);
      setError(null);
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const sessionId = await invoke<string>("connect_saved_host", { hostId: host.id });

        const label = host.label || `${host.username}@${host.host}`;
        useSessionStore.getState().replacePendingPane(pendingId, sessionId, {
          host: host.host,
          port: host.port,
          username: host.username,
          label: host.label || undefined,
          auth_method: { type: "password", password: "" },
        });
        useUiStore.getState().removePendingPane(pendingId);
        // Re-key the unified tab if this was a pending tab
        const tabStore = useTabStore.getState();
        if (tabStore.tabs.has(pendingId)) {
          tabStore.removeTab(pendingId);
          tabStore.addTab({ type: "terminal", id: sessionId, label });
        }
        void useHostsStore.getState().recordConnection(host.id);
      } catch (err) {
        const msg = err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : "Connection failed";
        setError(msg);
        setConnecting(null);
      }
    },
    [pendingId, connecting],
  );

  const connectRecent = useCallback(
    async (conn: RecentConnection) => {
      if (connecting) return;
      setConnecting(conn.host_id);
      setError(null);
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const sessionId = await invoke<string>("connect_saved_host", { hostId: conn.host_id });

        const label = conn.host_label || `${conn.username}@${conn.host}`;
        useSessionStore.getState().replacePendingPane(pendingId, sessionId, {
          host: conn.host,
          port: conn.port,
          username: conn.username,
          label: conn.host_label || undefined,
          auth_method: { type: "password", password: "" },
        });
        useUiStore.getState().removePendingPane(pendingId);
        // Re-key the unified tab if this was a pending tab
        const tabStore = useTabStore.getState();
        if (tabStore.tabs.has(pendingId)) {
          tabStore.removeTab(pendingId);
          tabStore.addTab({ type: "terminal", id: sessionId, label });
        }
        void useHostsStore.getState().recordConnection(conn.host_id);
      } catch (err) {
        const msg = err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : "Connection failed";
        setError(msg);
        setConnecting(null);
      }
    },
    [pendingId, connecting],
  );

  const connectLocal = useCallback(async () => {
    if (connecting) return;
    setConnecting("__local__");
    setError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const sessionId = await invoke<string>("local_open_pty");

      const label = "Local Terminal";
      startBuffering(sessionId);

      // Add to session store as a local session
      useSessionStore.getState().replacePendingPane(pendingId, sessionId, {
        host: "localhost",
        port: 0,
        username: "",
        auth_method: { type: "password", password: "" },
        label,
      });
      // Mark as local so Terminal.tsx uses local_* commands
      const sessions = useSessionStore.getState().sessions;
      const session = sessions.get(sessionId);
      if (session) {
        sessions.set(sessionId, { ...session, isLocal: true });
      }
      useUiStore.getState().removePendingPane(pendingId);

      const tabStore = useTabStore.getState();
      if (tabStore.tabs.has(pendingId)) {
        tabStore.removeTab(pendingId);
        tabStore.addTab({ type: "terminal", id: sessionId, label });
      }
    } catch (err) {
      const msg = err && typeof err === "object" && "message" in err
        ? String((err as { message: string }).message)
        : "Failed to open local terminal";
      setError(msg);
      setConnecting(null);
    }
  }, [pendingId, connecting]);

  const lowerQuery = query.toLowerCase();
  const filteredHosts = hosts.filter(
    (h) =>
      h.label?.toLowerCase().includes(lowerQuery) ||
      h.host.toLowerCase().includes(lowerQuery) ||
      h.username.toLowerCase().includes(lowerQuery),
  );
  const filteredRecent = recentConnections.filter(
    (c) =>
      c.host_label?.toLowerCase().includes(lowerQuery) ||
      c.host.toLowerCase().includes(lowerQuery) ||
      c.username.toLowerCase().includes(lowerQuery),
  );

  return (
    <div className="h-full w-full flex flex-col items-center bg-bg-base overflow-hidden">
      {/* Centered card */}
      <div className="w-full max-w-[400px] flex flex-col mt-8 mx-4 max-h-[calc(100%-4rem)]">
        <h2 className="text-[length:var(--text-base)] font-medium text-text-primary mb-3">
          Select a connection
        </h2>

        {/* Search input */}
        <div className="flex items-center gap-2 px-3 py-2 bg-bg-overlay border border-border rounded-lg mb-2">
          <Search size={14} className="text-text-muted shrink-0" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search hosts..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 bg-transparent text-[length:var(--text-sm)] text-text-primary placeholder:text-text-muted outline-none"
          />
        </div>

        {error && (
          <div className="px-3 py-2 mb-2 text-[length:var(--text-sm)] text-status-error bg-status-error/10 border border-status-error/20 rounded-lg">
            {error}
          </div>
        )}

        {/* Local terminal */}
        <button
          disabled={connecting !== null}
          onClick={() => connectLocal()}
          className="w-full px-3 py-2.5 mb-2 flex items-center gap-2.5 text-left text-[length:var(--text-sm)] text-text-primary bg-bg-overlay border border-border rounded-lg hover:bg-bg-subtle transition-colors duration-[var(--duration-fast)] disabled:opacity-50"
        >
          <Monitor size={14} className="text-accent shrink-0" />
          <span className="font-medium">Local Terminal</span>
          {connecting === "__local__" && (
            <span className="ml-auto text-[length:var(--text-xs)] text-text-muted">Opening...</span>
          )}
        </button>

        {/* Scrollable host list */}
        <div className="flex-1 overflow-y-auto border border-border rounded-lg bg-bg-overlay">
          {/* Recent connections */}
          {filteredRecent.length > 0 && (
            <>
              <div className="px-3 py-1.5 text-[length:var(--text-xs)] text-text-muted font-medium uppercase tracking-wider bg-bg-subtle/50">
                Recent
              </div>
              {filteredRecent.map((conn) => (
                <button
                  key={conn.host_id + conn.connected_at}
                  disabled={connecting !== null}
                  onClick={() => connectRecent(conn)}
                  className="w-full px-3 py-2 flex items-center gap-2.5 text-left text-[length:var(--text-sm)] text-text-primary hover:bg-bg-subtle transition-colors duration-[var(--duration-fast)] disabled:opacity-50 border-b border-border/50 last:border-b-0"
                >
                  <Clock size={14} className="text-text-muted shrink-0" />
                  <span className="truncate">
                    {conn.host_label || `${conn.username}@${conn.host}`}
                  </span>
                  {connecting === conn.host_id && (
                    <span className="ml-auto text-[length:var(--text-xs)] text-text-muted">Connecting...</span>
                  )}
                </button>
              ))}
            </>
          )}

          {/* Saved hosts */}
          {filteredHosts.length > 0 && (
            <>
              <div className="px-3 py-1.5 text-[length:var(--text-xs)] text-text-muted font-medium uppercase tracking-wider bg-bg-subtle/50">
                Saved Hosts
              </div>
              {filteredHosts.map((host) => (
                <button
                  key={host.id}
                  disabled={connecting !== null}
                  onClick={() => connectToHost(host)}
                  className="w-full px-3 py-2 flex items-center gap-2.5 text-left text-[length:var(--text-sm)] text-text-primary hover:bg-bg-subtle transition-colors duration-[var(--duration-fast)] disabled:opacity-50 border-b border-border/50 last:border-b-0"
                >
                  <Server size={14} className="text-text-muted shrink-0" />
                  <div className="flex flex-col min-w-0">
                    <span className="truncate">{host.label || host.host}</span>
                    {host.label && (
                      <span className="text-[length:var(--text-xs)] text-text-muted truncate">
                        {host.username}@{host.host}:{host.port}
                      </span>
                    )}
                  </div>
                  {connecting === host.id && (
                    <span className="ml-auto text-[length:var(--text-xs)] text-text-muted shrink-0">Connecting...</span>
                  )}
                </button>
              ))}
            </>
          )}

          {filteredRecent.length === 0 && filteredHosts.length === 0 && (
            <div className="px-3 py-6 text-center text-[length:var(--text-sm)] text-text-muted">
              No hosts found
            </div>
          )}
        </div>

        {/* Add new connection */}
        <button
          onClick={() => {
            useUiStore.getState().setEditingHostId(NEW_HOST_ID);
          }}
          className="mt-2 px-3 py-2 flex items-center gap-2 text-[length:var(--text-sm)] text-accent hover:bg-bg-subtle rounded-lg transition-colors duration-[var(--duration-fast)]"
        >
          <Plus size={14} className="shrink-0" />
          Add New Connection
        </button>
      </div>
    </div>
  );
}
