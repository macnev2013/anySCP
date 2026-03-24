import { useState } from "react";
import { Folder, Trash2 } from "lucide-react";
import type { SnippetFolder } from "../../types";
import { ContextMenu } from "../shared/ContextMenu";

// ─── Folder colors ────────────────────────────────────────────────────────────

const FOLDER_COLOR_FALLBACK = "#6366f1";

interface SnippetFolderCardProps {
  folder: SnippetFolder;
  snippetCount: number;
  isSelected: boolean;
  onSelect: (folderId: string) => void;
  onDelete: (folderId: string) => void;
}

export function SnippetFolderCard({
  folder,
  snippetCount,
  isSelected,
  onSelect,
  onDelete,
}: SnippetFolderCardProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const contextItems = [
    {
      label: "Delete Folder",
      icon: Trash2,
      danger: true,
      onClick: () => onDelete(folder.id),
    },
  ];

  const color = folder.color ?? FOLDER_COLOR_FALLBACK;

  return (
    <>
      <button
        onClick={() => onSelect(folder.id)}
        onContextMenu={handleContextMenu}
        title={folder.name}
        aria-pressed={isSelected}
        className={[
          "group relative flex flex-col gap-2.5 p-3.5 rounded-xl text-left",
          "bg-bg-surface border transition-all duration-[var(--duration-fast)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          isSelected
            ? "border-accent ring-2 ring-accent/30 bg-accent-muted"
            : "border-border hover:border-border-focus hover:bg-bg-overlay",
        ].join(" ")}
      >
        {/* Icon */}
        <div
          className="flex items-center justify-center w-9 h-9 rounded-lg transition-colors duration-[var(--duration-fast)]"
          style={{ backgroundColor: `${color}20` }}
        >
          <Folder
            size={18}
            strokeWidth={1.8}
            style={{ color }}
            aria-hidden="true"
          />
        </div>

        {/* Name + count */}
        <div>
          <p className="text-[length:var(--text-sm)] font-medium text-text-primary truncate leading-tight">
            {folder.name}
          </p>
          <p className="text-[length:var(--text-xs)] text-text-muted mt-0.5">
            {snippetCount === 1 ? "1 snippet" : `${snippetCount} snippets`}
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
