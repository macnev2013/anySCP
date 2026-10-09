import { useState } from "react";
import type { HostConfig, SessionId } from "../../types";
import { useSessionStore } from "../../stores/session-store";
import { useTabStore } from "../../stores/tab-store";
import { ReconnectOverlay } from "../shared/ReconnectOverlay";

interface DisconnectOverlayProps {
  sessionId: SessionId;
  /** The unified tab that owns this pane — needed to clean up the tab bar. */
  tabId: string;
  status: "Disconnected" | "Error";
  message?: string;
  hostConfig: HostConfig;
}

export function DisconnectOverlay({
  sessionId,
  tabId,
  status,
  message,
  hostConfig,
}: DisconnectOverlayProps) {
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);

  async function handleReconnect() {
    setIsReconnecting(true);
    setReconnectError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");

      // Try to find a saved host matching this connection — use connect_saved_host
      // which reads credentials from the OS keychain
      const hosts = await invoke<{ id: string; host: string; port: number; username: string }[]>("list_hosts");
      const savedHost = hosts.find(
        (h) => h.host === hostConfig.host && h.port === hostConfig.port && h.username === hostConfig.username,
      );

      let newSessionId: string;
      if (savedHost) {
        newSessionId = await invoke<string>("connect_saved_host", { hostId: savedHost.id });
      } else {
        newSessionId = await invoke<string>("ssh_connect", { hostConfig });
      }

      const { removeSession, addSession } = useSessionStore.getState();
      const label = hostConfig.label || `${hostConfig.username}@${hostConfig.host}`;
      useTabStore.getState().removeTab(sessionId);
      removeSession(sessionId);
      addSession(newSessionId as SessionId, hostConfig);
      useTabStore.getState().addTab({ type: "terminal", id: newSessionId, label });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message
        : err && typeof err === "object" && "message" in err ? String((err as { message: string }).message)
        : "Reconnection failed";
      setReconnectError(msg);
      setIsReconnecting(false);
    }
  }

  function handleClose() {
    void (async () => {
      // Tear down the (already dead) backend session so it doesn't linger in
      // the manager's session map — mirrors the tab X button and ⌘W.
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("ssh_disconnect", { sessionId });
      } catch { /* already disconnected */ }

      useSessionStore.getState().removeSession(sessionId);

      // removeSession only prunes the session-store's layout tree. If this was
      // the tab's last pane, the unified tab is now orphaned in the tab bar
      // with no working session, so remove it too. For a split, the tab still
      // owns the surviving pane and must stay. (issue #42)
      if (!useSessionStore.getState().tabs.get(tabId)) {
        useTabStore.getState().removeTab(tabId);
      }
    })();
  }

  return (
    <ReconnectOverlay
      label={`${hostConfig.username}@${hostConfig.host}`}
      status={status}
      message={message}
      error={reconnectError}
      busy={isReconnecting}
      onReconnect={handleReconnect}
      onClose={handleClose}
    />
  );
}
