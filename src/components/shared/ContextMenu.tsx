import { useEffect, useLayoutEffect, useRef, useState } from "react";
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

const VIEWPORT_MARGIN = 8; // min gap between menu and viewport edge

// ─── Item ──────────────────────────────────────────────────────────────────────

function MenuRow({ item, onClose }: { item: ContextMenuItem; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [flip, setFlip] = useState(false);
  const [subShiftY, setSubShiftY] = useState(0);
  const hasSubmenu = !!item.submenu && item.submenu.length > 0;
  const Icon = item.icon;

  // Position the flyout from its rendered size (before paint): open to the left
  // when it would overflow the right viewport edge, shift up when it would
  // overflow the bottom.
  useLayoutEffect(() => {
    if (!open || !ref.current || !subRef.current) return;
    const rowRect = ref.current.getBoundingClientRect();
    const subRect = subRef.current.getBoundingClientRect();
    setFlip(rowRect.right + subRect.width > window.innerWidth - VIEWPORT_MARGIN);
    const overflowY = rowRect.top + subRect.height - (window.innerHeight - VIEWPORT_MARGIN);
    setSubShiftY(overflowY > 0 ? -overflowY : 0);
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
          ref={subRef}
          role="menu"
          style={{ top: subShiftY }}
          className={[
            // w-max: size to content — the row's containing block offers ~zero
            // width at left:100%, which would otherwise wrap long labels.
            "absolute z-10 py-1 w-max min-w-[160px]",
            flip ? "right-full mr-0.5" : "left-full ml-0.5",
            "bg-bg-overlay border border-border rounded-lg",
            "shadow-[var(--shadow-lg)]",
            // See root menu: transition-none keeps the flip/shift placement
            // from animating as a slide while preserving the entrance animation.
            "transition-none animate-in fade-in-0 zoom-in-95 duration-[var(--duration-fast)]",
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
  // Clamped coordinates, computed from the menu's rendered size. Until they
  // are known the menu renders hidden at the cursor — never at the origin, so
  // a stray paint of the measuring frame can't flash or slide from top-left.
  const [coords, setCoords] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    // w-max on the container means the measured size is its natural content
    // size no matter where the menu currently sits (no shrink-to-fit at the
    // viewport edge), so one measurement here is accurate.
    const rect = el.getBoundingClientRect();
    setCoords({
      x: Math.max(VIEWPORT_MARGIN, Math.min(position.x, window.innerWidth - rect.width - VIEWPORT_MARGIN)),
      y: Math.max(VIEWPORT_MARGIN, Math.min(position.y, window.innerHeight - rect.height - VIEWPORT_MARGIN)),
    });
  }, [position.x, position.y]);

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
    // Clicks on native window chrome (titlebar, traffic lights) and focus moves
    // to other apps never reach the document, so the menu would otherwise stick
    // around — e.g. surviving a fullscreen toggle. Blur/resize cover those.
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);

    return () => {
      document.removeEventListener("mousedown", handleClick, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Context menu"
      style={
        coords
          ? { left: coords.x, top: coords.y }
          : { left: position.x, top: position.y, visibility: "hidden" }
      }
      className={[
        "fixed z-50 py-1 w-max min-w-[160px]",
        "bg-bg-overlay border border-border rounded-lg",
        "shadow-[var(--shadow-lg)]",
        // transition-none matters: `duration-*` also sets transition-duration,
        // and with `transition-property` defaulting to `all` the measured
        // left/top placement would render as a visible slide across the screen.
        "transition-none animate-in fade-in-0 zoom-in-95 duration-[var(--duration-fast)]",
      ].join(" ")}
    >
      {items.map((item, index) => (
        <MenuRow key={index} item={item} onClose={onClose} />
      ))}
    </div>
  );
}
