import { useState } from "react";
import { Cloud, Pencil, Copy, Trash2, FolderOpen } from "lucide-react";
import type { S3Connection } from "../../types";
import { ContextMenu } from "../shared/ContextMenu";
import { ConfirmDangerDialog } from "../shared/ConfirmDangerDialog";
import { getHostColor } from "./HostCard";
import { CardActionButton, CardActionStrip } from "./CardActionButton";

interface S3CardProps {
  conn: S3Connection;
  onConnect: (conn: S3Connection) => void;
  onEdit: (conn: S3Connection) => void;
  onDuplicate: (conn: S3Connection) => void;
  onDelete: (conn: S3Connection) => void;
}

// ─── Environment badge (matches HostCard) ─────────────────────────────────────

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

export function S3Card({ conn, onConnect, onEdit, onDuplicate, onDelete }: S3CardProps) {
  const displayName = conn.label;
  const accentColor = conn.color || getHostColor(conn.label);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const subtitleParts: string[] = [conn.provider, conn.region];
  if (conn.bucket) subtitleParts.push(conn.bucket);
  const subtitle = subtitleParts.join(" · ");

  const env = conn.environment && isEnvironmentValue(conn.environment) ? conn.environment : null;

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onConnect(conn);
    }
  };

  const contextItems = [
    { label: "Explore", icon: FolderOpen, onClick: () => onConnect(conn) },
    { label: "Edit", icon: Pencil, onClick: () => onEdit(conn) },
    { label: "Duplicate", icon: Copy, onClick: () => onDuplicate(conn) },
    { label: "Delete", icon: Trash2, danger: true, separator: true, onClick: () => setConfirmDelete(true) },
  ];

  return (
    <>
      <div
        data-testid={`s3-card-${conn.id}`}
        data-s3-id={conn.id}
        data-s3-label={displayName}
        role="button"
        tabIndex={0}
        onClick={() => onConnect(conn)}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
        title={`Connect to ${displayName}`}
        className={[
          // grab/grabbing communicates the card is draggable; a plain click still
          // connects (drag needs a 5px move to activate first).
          "group relative isolate flex flex-col gap-2.5 p-3.5 rounded-xl text-left w-full h-full cursor-grab active:cursor-grabbing overflow-hidden",
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
            background: `radial-gradient(circle at top left, ${accentColor}33, transparent 60%)`,
          }}
          aria-hidden="true"
        />

        {/* Action buttons (top-right) */}
        <CardActionStrip>
          <CardActionButton
            icon={FolderOpen}
            label="Explore"
            onClick={() => onConnect(conn)}
            ariaLabel={`Open explorer for ${displayName}`}
            testId={`s3-card-${conn.id}-explorer`}
          />
        </CardActionStrip>

        {/* Avatar circle */}
        <div
          className="flex items-center justify-center w-9 h-9 rounded-full shrink-0 select-none"
          style={{
            backgroundColor: `${accentColor}25`,
            color: accentColor,
          }}
          aria-hidden="true"
        >
          <Cloud size={16} strokeWidth={2} />
        </div>

        {/* Connection info */}
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

      <ConfirmDangerDialog
        open={confirmDelete}
        title="Delete this S3 connection?"
        message="This connection will be permanently removed."
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          onDelete(conn);
        }}
      />
    </>
  );
}
