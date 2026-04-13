import { useState } from "react";
import { WifiOff, AlertTriangle, RefreshCw, X } from "lucide-react";
import type { HostConfig, SessionId } from "../../types";
import { useSessionStore } from "../../stores/session-store";
import { useTabStore } from "../../stores/tab-store";

interface DisconnectOverlayProps {
  sessionId: SessionId;
  status: "Disconnected" | "Error";
  message?: string;
  hostConfig: HostConfig;
}

export function DisconnectOverlay({
  sessionId,
  status,
  message,
  hostConfig,
}: DisconnectOverlayProps) {
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);

  const isError = status === "Error";

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
    useSessionStore.getState().removeSession(sessionId);
  }

  return (
    <div
      className="absolute inset-0 z-10 flex items-end justify-center pb-6 pointer-events-none"
      aria-modal="true"
      role="dialog"
      aria-label={isError ? "Connection error" : "Connection lost"}
    >
      {/* Pill-shaped toast anchored to the bottom of the terminal */}
      <div
        className="pointer-events-auto flex items-center gap-3 pl-3 pr-1.5 py-1.5 rounded-full bg-bg-overlay/95 border border-border shadow-[var(--shadow-lg)] backdrop-blur-md motion-safe:animate-[toast-up_var(--duration-slow)_var(--ease-expo-out)_both]"
      >
        {/* Status indicator */}
        <div className={`flex items-center justify-center w-5 h-5 rounded-full shrink-0 ${isError ? "bg-status-error/15" : "bg-bg-subtle"}`}>
          {isError
            ? <AlertTriangle size={10} strokeWidth={2.5} className="text-status-error" aria-hidden="true" />
            : <WifiOff size={10} strokeWidth={2.5} className="text-text-muted" aria-hidden="true" />
          }
        </div>

        {/* Label */}
        <span className="text-[length:var(--text-xs)] text-text-muted font-mono truncate max-w-[160px]">
          {hostConfig.username}@{hostConfig.host}
        </span>

        {/* Error detail — only if present and short */}
        {(reconnectError || message) && (
          <span className="text-[10px] text-status-error truncate max-w-[120px]" title={reconnectError || message || ""}>
            {reconnectError || message}
          </span>
        )}

        {/* Divider */}
        <div className="w-px h-4 bg-border shrink-0" aria-hidden="true" />

        {/* Reconnect */}
        <button
          type="button"
          onClick={handleReconnect}
          disabled={isReconnecting}
          className="inline-flex items-center gap-1 h-6 px-2.5 rounded-full text-[11px] font-medium text-text-inverse bg-accent hover:bg-accent-hover disabled:opacity-50 transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0"
          aria-label="Reconnect"
        >
          <RefreshCw
            size={10}
            strokeWidth={2.5}
            aria-hidden="true"
            className={isReconnecting ? "motion-safe:animate-spin" : ""}
          />
          {isReconnecting ? "Connecting" : "Reconnect"}
        </button>

        {/* Close */}
        <button
          type="button"
          onClick={handleClose}
          disabled={isReconnecting}
          className="inline-flex items-center justify-center w-6 h-6 rounded-full text-text-muted hover:text-text-primary hover:bg-bg-subtle disabled:opacity-50 transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0"
          aria-label="Close session"
        >
          <X size={11} strokeWidth={2.2} aria-hidden="true" />
        </button>
      </div>

      <style>{`
        @keyframes toast-up {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
