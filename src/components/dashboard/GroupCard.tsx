import { useState } from "react";
import { Trash2 } from "lucide-react";
import type { HostGroup } from "../../types";
import { ContextMenu } from "../shared/ContextMenu";
import { resolveGroupIcon } from "./GroupModal";

interface GroupCardProps {
  group: HostGroup;
  hostCount: number;
  isSelected: boolean;
  onSelect: (groupId: string) => void;
  onDelete: (groupId: string) => void;
}

export function GroupCard({ group, hostCount, isSelected, onSelect, onDelete }: GroupCardProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const contextItems = [
    {
      label: "Delete Group",
      icon: Trash2,
      danger: true,
      onClick: () => onDelete(group.id),
    },
  ];

  const Icon = resolveGroupIcon(group.icon);

  return (
    <>
      <button
        data-testid={`group-card-${group.id}`}
        data-group-id={group.id}
        data-group-name={group.name}
        onClick={() => onSelect(group.id)}
        onContextMenu={handleContextMenu}
        title={group.name}
        aria-pressed={isSelected}
        className={[
          // grab/grabbing communicates the card is draggable; a plain click still
          // selects/filters the group (drag needs a 5px move to activate first).
          "group relative flex flex-col gap-2.5 p-3.5 rounded-xl text-left w-full h-full cursor-grab active:cursor-grabbing",
          "bg-bg-surface border transition-all duration-[var(--duration-fast)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          isSelected
            ? "border-accent ring-2 ring-accent/30 bg-accent-muted"
            : "border-border hover:border-border-focus hover:bg-bg-overlay",
        ].join(" ")}
      >
        {/* Icon with group color */}
        <div
          className="flex items-center justify-center w-9 h-9 rounded-lg"
          style={{ backgroundColor: `${group.color}20` }}
        >
          <Icon
            size={19}
            strokeWidth={1.8}
            style={{ color: group.color }}
            aria-hidden="true"
          />
        </div>

        {/* Name */}
        <div>
          <p className="text-[length:var(--text-sm)] font-medium text-text-primary truncate leading-tight">
            {group.name}
          </p>
          <p className="text-[length:var(--text-xs)] text-text-muted mt-0.5">
            {hostCount === 1 ? "1 host" : `${hostCount} hosts`}
          </p>
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
