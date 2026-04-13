import { useState, useEffect, useRef } from "react";
import { useRdpStore } from "../../stores/rdp-store";
import { useTabStore } from "../../stores/tab-store";
import type { RdpConfig } from "../../types";

interface RdpConnectDialogProps {
  onClose: () => void;
}

export function RdpConnectDialog({ onClose }: RdpConnectDialogProps) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("3389");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [domain, setDomain] = useState("");
  const [width, setWidth] = useState("1920");
  const [height, setHeight] = useState("1080");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hostRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    hostRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !connecting) onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, connecting]);

  const canSubmit = host.trim() && username.trim() && password.trim();

  const handleConnect = async () => {
    if (!canSubmit || connecting) return;
    setConnecting(true);
    setError(null);

    try {
      const { invoke } = await import("@tauri-apps/api/core");

      const config: RdpConfig = {
        host: host.trim(),
        port: parseInt(port, 10) || 3389,
        username: username.trim(),
        password,
        domain: domain.trim() || undefined,
        width: parseInt(width, 10) || 1920,
        height: parseInt(height, 10) || 1080,
      };

      const result = await invoke<{ session_id: string; ws_port: number }>("rdp_connect", { config });

      const label = `${config.username}@${config.host} (RDP)`;
      useRdpStore.getState().addSession(result.session_id, config, result.ws_port);
      useTabStore.getState().addTab({ type: "rdp", id: result.session_id, label });

      onClose();
    } catch (err) {
      const msg =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : "RDP connection failed";
      setError(msg);
    } finally {
      setConnecting(false);
    }
  };

  const inputClass = [
    "w-full px-3 py-2 rounded-lg text-[length:var(--text-sm)]",
    "bg-bg-surface border border-border text-text-primary placeholder:text-text-muted",
    "outline-none transition-[border-color,box-shadow] duration-[var(--duration-fast)]",
    "focus:border-border-focus focus:ring-2 focus:ring-ring",
  ].join(" ");

  const labelClass =
    "block text-[length:var(--text-xs)] font-medium text-text-secondary mb-1.5";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg-base/60 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && !connecting && onClose()}
    >
      <div className="w-full max-w-md mx-4 rounded-xl bg-bg-overlay border border-border p-6 shadow-[var(--shadow-lg)] animate-[fadeIn_120ms_var(--ease-expo-out)_both]">
        <h2 className="text-[length:var(--text-base)] font-semibold text-text-primary mb-5">
          RDP Connection
        </h2>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleConnect();
          }}
          className="flex flex-col gap-4"
        >
          {/* Host + Port */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className={labelClass}>Host</label>
              <input
                ref={hostRef}
                type="text"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.100"
                className={inputClass}
              />
            </div>
            <div className="w-24">
              <label className={labelClass}>Port</label>
              <input
                type="text"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="3389"
                className={inputClass}
              />
            </div>
          </div>

          {/* Username */}
          <div>
            <label className={labelClass}>Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Administrator"
              className={inputClass}
            />
          </div>

          {/* Password */}
          <div>
            <label className={labelClass}>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
          </div>

          {/* Domain (optional) */}
          <div>
            <label className={labelClass}>
              Domain <span className="text-text-muted font-normal">(optional)</span>
            </label>
            <input
              type="text"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="WORKGROUP"
              className={inputClass}
            />
          </div>

          {/* Resolution */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className={labelClass}>Width</label>
              <input
                type="text"
                value={width}
                onChange={(e) => setWidth(e.target.value)}
                placeholder="1920"
                className={inputClass}
              />
            </div>
            <div className="flex-1">
              <label className={labelClass}>Height</label>
              <input
                type="text"
                value={height}
                onChange={(e) => setHeight(e.target.value)}
                placeholder="1080"
                className={inputClass}
              />
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="rounded-lg bg-status-error/5 border border-status-error/20 px-3 py-2.5">
              <p className="text-[length:var(--text-xs)] text-status-error leading-relaxed">
                {error}
              </p>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={connecting}
              className="px-4 py-2 text-[length:var(--text-sm)] text-text-secondary hover:text-text-primary rounded-lg transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit || connecting}
              className={[
                "px-4 py-2 text-[length:var(--text-sm)] font-medium rounded-lg",
                "transition-colors duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                canSubmit && !connecting
                  ? "bg-accent hover:bg-accent-hover text-text-inverse"
                  : "bg-bg-subtle text-text-muted cursor-not-allowed",
              ].join(" ")}
            >
              {connecting ? "Connecting..." : "Connect"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
