export interface CardActionButtonProps {
  icon: React.ElementType;
  label: string;
  /** Invoked on click; the button stops propagation so the card doesn't also fire. */
  onClick: () => void;
  ariaLabel: string;
  /** Replaces `label` in the tooltip pill (e.g. a ping result). No native
   *  `title` — it would double up with the pill. */
  detail?: string;
  testId?: string;
  disabled?: boolean;
  /** Adds aria-busy and pulses the icon (e.g. an in-flight ping). */
  busy?: boolean;
  /** Resting text color; defaults to muted. Ping overrides with its status hue. */
  colorClass?: string;
}

/**
 * A fixed-size icon button for a card's top-right action strip. The width never
 * changes on hover, so hovering one can't shift its neighbours, and the label
 * shows as a tooltip below (absolute — reflows nothing) only while this button
 * is hovered. Wrap a row of these in CardActionStrip.
 */
export function CardActionButton({
  icon: Icon,
  label,
  onClick,
  ariaLabel,
  detail,
  testId,
  disabled = false,
  busy = false,
  colorClass = "text-text-muted",
}: CardActionButtonProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      disabled={disabled}
      aria-busy={busy || undefined}
      aria-label={ariaLabel}
      className={[
        "group/btn relative flex items-center justify-center h-8 w-8 rounded-md",
        colorClass,
        "hover:text-text-primary hover:bg-bg-overlay",
        "transition-[background-color,color] duration-[var(--duration-fast)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed",
      ].join(" ")}
    >
      <Icon
        size={16}
        strokeWidth={2}
        aria-hidden="true"
        className={busy ? "shrink-0 motion-safe:animate-pulse" : "shrink-0"}
      />
      <span
        className={[
          "absolute top-full right-0 mt-1 z-10 pointer-events-none",
          "px-1.5 py-0.5 rounded-md bg-bg-overlay border border-border shadow-[var(--shadow-md)]",
          "whitespace-nowrap text-[length:var(--text-xs)] font-medium text-text-primary",
          "opacity-0 group-hover/btn:opacity-100 group-focus-visible/btn:opacity-100 transition-opacity duration-[var(--duration-fast)]",
        ].join(" ")}
      >
        {detail ?? label}
      </span>
    </button>
  );
}

/** Top-right container for a row of CardActionButtons. Flush (no gap) so the
 *  hover targets are contiguous and the cursor never flashes over a dead gap. */
export function CardActionStrip({ children }: { children: React.ReactNode }) {
  return <div className="absolute top-2 right-2 flex items-center">{children}</div>;
}
