import { useState } from "react";
import { Pencil, TerminalSquare, Copy, Trash2, FolderOpen } from "lucide-react";
import type { SavedHost } from "../../types";
import { relativeTime } from "../../utils/time";
import { ContextMenu } from "../shared/ContextMenu";

interface HostCardProps {
  host: SavedHost;
  onConnect: (host: SavedHost) => void;
  onExplore: (host: SavedHost) => void;
  onEdit: (hostId: string) => void;
  onDelete: (hostId: string) => void;
  onDuplicate: (host: SavedHost) => void;
}

export const HOST_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
];

export function getHostColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return HOST_COLORS[Math.abs(hash) % HOST_COLORS.length];
}

// ─── Environment badge ────────────────────────────────────────────────────────

type EnvironmentValue = "production" | "staging" | "dev" | "testing";

const ENV_BADGE_CLASSES: Record<EnvironmentValue, string> = {
  production: "bg-[oklch(0.650_0.200_25/0.15)] text-[oklch(0.650_0.200_25)]",
  staging:    "bg-[oklch(0.750_0.160_80/0.15)] text-[oklch(0.750_0.160_80)]",
  dev:        "bg-[oklch(0.720_0.180_155/0.15)] text-[oklch(0.720_0.180_155)]",
  testing:    "bg-[oklch(0.700_0.150_250/0.15)] text-[oklch(0.700_0.150_250)]",
};

const ENV_LABELS: Record<EnvironmentValue, string> = {
  production: "PROD",
  staging:    "STAGE",
  dev:        "DEV",
  testing:    "TEST",
};

function isEnvironmentValue(val: string): val is EnvironmentValue {
  return val === "production" || val === "staging" || val === "dev" || val === "testing";
}

// ─── Component ────────────────────────────────────────────────────────────────

export function HostCard({ host, onConnect, onExplore, onEdit, onDelete, onDuplicate }: HostCardProps) {
  const displayName = host.label || host.host;
  const avatarColor = host.color || getHostColor(host.host);
  const initial = displayName.charAt(0).toUpperCase();

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  // Build subtitle segments
  const subtitleParts: string[] = [`SSH, ${host.username}`];
  if (host.os_type) {
    const osLabels: Record<string, string> = {
      linux: "Linux",
      macos: "macOS",
      windows: "Windows",
      freebsd: "FreeBSD",
    };
    subtitleParts.push(osLabels[host.os_type] ?? host.os_type);
  }
  const lastSeen = host.last_connected_at ? relativeTime(host.last_connected_at) : null;
  if (lastSeen) subtitleParts.push(lastSeen);

  const subtitle = subtitleParts.join(" · ");

  const env = host.environment && isEnvironmentValue(host.environment) ? host.environment : null;

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const contextItems = [
    {
      label: "Terminal",
      icon: TerminalSquare,
      onClick: () => onConnect(host),
    },
    {
      label: "Explorer",
      icon: FolderOpen,
      onClick: () => onExplore(host),
    },
    {
      label: "Edit",
      icon: Pencil,
      onClick: () => onEdit(host.id),
    },
    {
      label: "Duplicate",
      icon: Copy,
      onClick: () => onDuplicate(host),
    },
    {
      label: "Delete",
      icon: Trash2,
      danger: true,
      onClick: () => onDelete(host.id),
    },
  ];

  return (
    <>
      <button
        onClick={() => onConnect(host)}
        onContextMenu={handleContextMenu}
        title={`Connect to ${displayName}`}
        className={[
          "group relative flex flex-col gap-2.5 p-3.5 rounded-xl text-left w-full",
          "bg-bg-surface border border-border",
          "hover:border-border-focus hover:bg-bg-overlay",
          "transition-all duration-[var(--duration-fast)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        ].join(" ")}
      >

        {/* Avatar circle */}
        <div
          className="flex items-center justify-center w-9 h-9 rounded-full shrink-0 font-semibold text-[length:var(--text-sm)] select-none"
          style={{
            backgroundColor: `${avatarColor}25`,
            color: avatarColor,
            fontFamily: "var(--font-sans)",
          }}
          aria-hidden="true"
        >
          {initial}
        </div>

        {/* Host info */}
        <div className="min-w-0">
          <p className="text-[length:var(--text-sm)] font-medium text-text-primary truncate leading-tight pr-5">
            {displayName}
          </p>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            <p className="text-[length:var(--text-xs)] text-text-muted font-mono truncate">
              {subtitle}
            </p>
            {env && (
              <span
                className={[
                  "inline-flex items-center px-1 py-px rounded text-[10px] font-semibold tracking-wide leading-none shrink-0",
                  ENV_BADGE_CLASSES[env],
                ].join(" ")}
              >
                {ENV_LABELS[env]}
              </span>
            )}
          </div>
        </div>
      </button>

      {contextMenu && (
        <ContextMenu
          items={contextItems}
          position={contextMenu}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
}
