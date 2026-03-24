import type { RecentConnection } from "../../types";
import { getHostColor } from "./HostCard";
import { relativeTime } from "../../utils/time";

// ─── Props ────────────────────────────────────────────────────────────────────

interface RecentConnectionsProps {
  connections: RecentConnection[];
  onConnect: (connection: RecentConnection) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function RecentConnections({
  connections,
  onConnect,
}: RecentConnectionsProps) {
  if (connections.length === 0) return null;

  return (
    <section aria-labelledby="recent-heading">
      <h2
        id="recent-heading"
        className="text-[length:var(--text-xs)] font-semibold uppercase tracking-widest text-text-muted mb-3"
      >
        Recent
      </h2>

      {/* Horizontal scrollable chip row */}
      <div
        className="flex gap-2 overflow-x-auto pb-1"
        style={{ scrollbarWidth: "none" }}
        role="list"
        aria-label="Recent connections"
      >
        {connections.map((conn) => {
          const displayName = conn.host_label || conn.host;
          const color = getHostColor(conn.host);
          const timestamp = relativeTime(conn.connected_at);

          return (
            <button
              key={`${conn.host_id}-${conn.connected_at}`}
              role="listitem"
              onClick={() => onConnect(conn)}
              title={`Reconnect to ${displayName} (${conn.username}@${conn.host}:${conn.port})`}
              className={[
                "flex items-center gap-2 px-3 py-1.5 rounded-lg shrink-0",
                "bg-bg-surface border border-border",
                "hover:border-border-focus hover:bg-bg-overlay",
                "transition-all duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              ].join(" ")}
            >
              {/* Status dot */}
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ backgroundColor: color }}
                aria-hidden="true"
              />

              {/* Host label */}
              <span className="text-[length:var(--text-xs)] font-medium text-text-primary max-w-[120px] truncate">
                {displayName}
              </span>

              {/* Timestamp */}
              <span className="text-[length:var(--text-xs)] text-text-muted whitespace-nowrap">
                {timestamp}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
