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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onConnect(host);
    }
  };

  const stopAnd = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };

  return (
    <>
      <div
        data-testid={`host-card-${host.id}`}
        data-host-id={host.id}
        data-host-label={displayName}
        role="button"
        tabIndex={0}
        onClick={() => onConnect(host)}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
        title={`Connect to ${displayName}`}
        className={[
          "group relative isolate flex flex-col gap-2.5 p-3.5 rounded-xl text-left w-full cursor-pointer overflow-hidden",
          "bg-bg-surface border border-border",
          "hover:border-border-focus hover:bg-bg-overlay",
          "transition-[background-color,border-color] duration-[var(--duration-fast)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        ].join(" ")}
      >

        {/* Color accent gradient */}
        <div
          className="absolute inset-0 pointer-events-none -z-10 opacity-70 group-hover:opacity-100 transition-opacity duration-[var(--duration-fast)]"
          style={{
            background: `radial-gradient(circle at top left, ${avatarColor}33, transparent 60%)`,
          }}
          aria-hidden="true"
        />

        {/* Action buttons (top-right) */}
        <div className="absolute top-2 right-2 flex items-center gap-0.5">
          <button
            type="button"
            data-testid={`host-card-${host.id}-terminal`}
            onClick={stopAnd(() => onConnect(host))}
            title="Open Terminal"
            aria-label={`Open terminal for ${displayName}`}
            className={[
              "group/btn flex items-center h-8 px-2 rounded-md",
              "text-text-muted hover:text-text-primary hover:bg-bg-overlay",
              "transition-[background-color,color] duration-[var(--duration-fast)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            ].join(" ")}
          >
            <TerminalSquare size={16} strokeWidth={2} aria-hidden="true" className="shrink-0" />
            <span
              className={[
                "overflow-hidden whitespace-nowrap text-[length:var(--text-xs)] font-medium",
                "max-w-0 ml-0 group-hover/btn:max-w-[70px] group-hover/btn:ml-1",
                "transition-[max-width,margin-left] duration-200 ease-out",
              ].join(" ")}
            >
              Terminal
            </span>
          </button>
          <button
            type="button"
            data-testid={`host-card-${host.id}-explorer`}
            onClick={stopAnd(() => onExplore(host))}
            title="Open Explorer"
            aria-label={`Open explorer for ${displayName}`}
            className={[
              "group/btn flex items-center h-8 px-2 rounded-md",
              "text-text-muted hover:text-text-primary hover:bg-bg-overlay",
              "transition-[background-color,color] duration-[var(--duration-fast)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            ].join(" ")}
          >
            <FolderOpen size={16} strokeWidth={2} aria-hidden="true" className="shrink-0" />
            <span
              className={[
                "overflow-hidden whitespace-nowrap text-[length:var(--text-xs)] font-medium",
                "max-w-0 ml-0 group-hover/btn:max-w-[70px] group-hover/btn:ml-1",
                "transition-[max-width,margin-left] duration-200 ease-out",
              ].join(" ")}
            >
              Explorer
            </span>
          </button>
        </div>

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
                  "inline-flex items-center px-1 py-px rounded text-[11px] font-semibold tracking-wide leading-none shrink-0",
                  ENV_BADGE_CLASSES[env],
                ].join(" ")}
              >
                {ENV_LABELS[env]}
              </span>
            )}
          </div>
        </div>

      </div>

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
