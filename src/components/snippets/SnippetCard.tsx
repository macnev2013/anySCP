import { useState } from "react";
import { Pencil, Copy, Trash2, AlertTriangle } from "lucide-react";
import type { Snippet } from "../../types";
import { ContextMenu } from "../shared/ContextMenu";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VAR_REGEX = /(\{\{[a-zA-Z_][a-zA-Z0-9_]*\}\})/g;

/** Render a command string with {{variable}} tokens highlighted. */
function HighlightedCommand({ command }: { command: string }) {
  const parts = command.split(VAR_REGEX);
  return (
    <span>
      {parts.map((part, i) =>
        VAR_REGEX.test(part) ? (
          <span key={i} className="text-accent font-medium">
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </span>
  );
}

function formatLastUsed(iso: string | null): string {
  if (!iso) return "never";
  const date = new Date(iso);
  const now = Date.now();
  const diff = now - date.getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}yr ago`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface SnippetCardProps {
  snippet: Snippet;
  onEdit: (snippet: Snippet) => void;
  onDelete: (id: string) => void;
  onDuplicate: (snippet: Snippet) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SnippetCard({ snippet, onEdit, onDelete, onDuplicate }: SnippetCardProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const tags = snippet.tags
    ? snippet.tags.split(",").map((t) => t.trim()).filter(Boolean)
    : [];

  const contextItems = [
    {
      label: "Edit",
      icon: Pencil,
      onClick: () => onEdit(snippet),
    },
    {
      label: "Duplicate",
      icon: Copy,
      onClick: () => onDuplicate(snippet),
    },
    {
      label: "Delete",
      icon: Trash2,
      danger: true,
      onClick: () => onDelete(snippet.id),
    },
  ];

  return (
    <>
      <div
        onContextMenu={handleContextMenu}
        className={[
          "group flex flex-col gap-2 p-4 rounded-xl",
          "bg-bg-surface border border-border",
          "hover:border-border-focus hover:bg-bg-overlay",
          "transition-all duration-[var(--duration-fast)]",
        ].join(" ")}
      >
        {/* Top row: name + actions */}
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-[length:var(--text-sm)] font-semibold text-text-primary leading-tight truncate">
                {snippet.name}
              </h3>
              {snippet.is_dangerous && (
                <AlertTriangle
                  size={13}
                  strokeWidth={2}
                  className="text-status-error shrink-0"
                  aria-label="Dangerous — requires confirmation"
                />
              )}
            </div>
          </div>

          {/* Edit button — visible on hover */}
          <button
            onClick={() => onEdit(snippet)}
            title="Edit snippet"
            aria-label="Edit snippet"
            className={[
              "shrink-0 flex items-center justify-center w-7 h-7 rounded-md",
              "text-text-muted hover:text-text-secondary hover:bg-bg-subtle",
              "opacity-0 group-hover:opacity-100",
              "transition-all duration-[var(--duration-fast)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:opacity-100",
            ].join(" ")}
          >
            <Pencil size={15} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>

        {/* Command (monospace, truncated to 2 lines) */}
        <p
          className={[
            "font-mono text-[length:var(--text-xs)] text-text-muted leading-relaxed",
            "line-clamp-2 break-all",
          ].join(" ")}
        >
          <HighlightedCommand command={snippet.command} />
        </p>

        {/* Footer: tags + use count */}
        <div className="flex items-center gap-2 flex-wrap">
          {tags.map((tag) => (
            <span
              key={tag}
              className={[
                "inline-flex items-center px-1.5 py-0.5 rounded-md",
                "text-[10px] font-medium text-text-muted bg-bg-subtle border border-border",
              ].join(" ")}
            >
              {tag}
            </span>
          ))}

          <span className="ml-auto text-[10px] text-text-muted shrink-0 whitespace-nowrap">
            {snippet.use_count > 0
              ? `Used ${snippet.use_count}x · ${formatLastUsed(snippet.last_used_at)}`
              : "Never used"}
          </span>
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
