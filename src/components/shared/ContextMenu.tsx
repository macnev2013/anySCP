import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";

export interface ContextMenuItem {
  label: string;
  icon?: React.ElementType;
  /** Leaf action. Omitted for items that only open a `submenu`. */
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Render a separator line above this item */
  separator?: boolean;
  /** Nested items — turns this row into a flyout submenu. */
  submenu?: ContextMenuItem[];
}

interface ContextMenuProps {
  items: ContextMenuItem[];
  position: { x: number; y: number };
  onClose: () => void;
}

// ─── Viewport-aware positioning ───────────────────────────────────────────────

const MENU_WIDTH = 180;
const ESTIMATED_ITEM_HEIGHT = 32; // px per item
const PADDING_V = 8; // top + bottom padding

function clampPosition(
  x: number,
  y: number,
  itemCount: number,
): { x: number; y: number } {
  const menuHeight = itemCount * ESTIMATED_ITEM_HEIGHT + PADDING_V;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const clampedX = x + MENU_WIDTH > vw ? vw - MENU_WIDTH - 8 : x;
  const clampedY = y + menuHeight > vh ? vh - menuHeight - 8 : y;

  return { x: Math.max(8, clampedX), y: Math.max(8, clampedY) };
}

// ─── Item ──────────────────────────────────────────────────────────────────────

function MenuRow({ item, onClose }: { item: ContextMenuItem; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [flip, setFlip] = useState(false);
  const hasSubmenu = !!item.submenu && item.submenu.length > 0;
  const Icon = item.icon;

  // Open the flyout to the left when it would overflow the right viewport edge.
  useEffect(() => {
    if (open && ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setFlip(rect.right + MENU_WIDTH > window.innerWidth);
    }
  }, [open]);

  return (
    <div
      ref={ref}
      className="relative"
      onMouseEnter={() => hasSubmenu && setOpen(true)}
      onMouseLeave={() => hasSubmenu && setOpen(false)}
    >
      {item.separator && <div className="h-px bg-border my-1" role="separator" />}
      <button
        role="menuitem"
        aria-haspopup={hasSubmenu || undefined}
        aria-expanded={hasSubmenu ? open : undefined}
        disabled={item.disabled}
        onClick={() => {
          if (item.disabled) return;
          if (hasSubmenu) {
            setOpen((o) => !o);
            return;
          }
          item.onClick?.();
          onClose();
        }}
        className={[
          "w-full px-3 py-1.5 flex items-center gap-2",
          "text-[length:var(--text-sm)] text-left cursor-pointer",
          "transition-colors duration-[var(--duration-fast)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          item.disabled
            ? "opacity-40 pointer-events-none"
            : item.danger
              ? "text-status-error hover:bg-status-error/10"
              : "text-text-primary hover:bg-bg-subtle",
        ].join(" ")}
      >
        {Icon && (
          <Icon
            size={15}
            strokeWidth={1.8}
            aria-hidden="true"
            className={item.danger ? "text-status-error" : "text-text-muted"}
          />
        )}
        <span className="flex-1 truncate">{item.label}</span>
        {hasSubmenu && <ChevronRight size={14} strokeWidth={1.8} aria-hidden="true" className="-mr-1 text-text-muted" />}
      </button>

      {hasSubmenu && open && (
        <div
          role="menu"
          className={[
            "absolute top-0 z-10 py-1 min-w-[160px]",
            flip ? "right-full mr-0.5" : "left-full ml-0.5",
            "bg-bg-overlay border border-border rounded-lg",
            "shadow-[var(--shadow-lg)]",
            "animate-in fade-in-0 zoom-in-95 duration-[var(--duration-fast)]",
          ].join(" ")}
        >
          {item.submenu!.map((sub, i) => (
            <MenuRow key={i} item={sub} onClose={onClose} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ContextMenu({ items, position, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const { x, y } = clampPosition(position.x, position.y, items.length);

  // Close on outside click or Escape
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };

    // Use capture so we catch clicks that land on other interactive elements
    document.addEventListener("mousedown", handleClick, true);
    document.addEventListener("keydown", handleKeyDown, true);

    return () => {
      document.removeEventListener("mousedown", handleClick, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Context menu"
      style={{ left: x, top: y }}
      className={[
        "fixed z-50 py-1 min-w-[160px]",
        "bg-bg-overlay border border-border rounded-lg",
        "shadow-[var(--shadow-lg)]",
        "animate-in fade-in-0 zoom-in-95 duration-[var(--duration-fast)]",
      ].join(" ")}
    >
      {items.map((item, index) => (
        <MenuRow key={index} item={item} onClose={onClose} />
      ))}
    </div>
  );
}
