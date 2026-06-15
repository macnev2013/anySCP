import { useState, useEffect, useRef, useId } from "react";
import { X } from "lucide-react";

// ─── Shared button styles ─────────────────────────────────────────────────────
// Import these in any modal footer so every button looks identical.

export const BTN_GHOST =
  "px-4 py-1.5 text-[length:var(--text-sm)] font-medium text-text-secondary hover:text-text-primary rounded-lg transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

export const BTN_SECONDARY =
  "px-4 py-1.5 text-[length:var(--text-sm)] font-medium text-text-secondary hover:text-text-primary bg-bg-subtle hover:bg-bg-muted border border-border disabled:opacity-50 rounded-lg transition-all duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export const BTN_PRIMARY =
  "px-4 py-1.5 text-[length:var(--text-sm)] font-medium text-text-inverse bg-accent hover:bg-accent-hover disabled:opacity-50 rounded-lg transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg-overlay";

export const BTN_DANGER =
  "px-4 py-1.5 text-[length:var(--text-sm)] font-medium text-text-inverse bg-status-error hover:opacity-90 active:opacity-80 disabled:opacity-50 rounded-lg transition-opacity duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

// ─── ModalShell ───────────────────────────────────────────────────────────────

const MAX_W: Record<NonNullable<ModalShellProps["maxWidth"]>, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
};

export interface ModalShellProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Optional subtitle line below the title (e.g. snippet command preview). */
  subtitle?: string;
  /**
   * Standard Lucide icon component. Rendered at size=16 inside a rounded
   * accent-tinted container. Use `iconVariant="danger"` for error-red icons.
   */
  icon?: React.ElementType;
  /** Color scheme for the built-in icon container. Defaults to "accent". */
  iconVariant?: "accent" | "danger";
  /**
   * Fully custom icon node — replaces the built-in icon container entirely.
   * Use this when the icon has a dynamic/user-chosen color (e.g. GroupModal).
   */
  iconNode?: React.ReactNode;
  /** Panel max-width. Defaults to "lg". */
  maxWidth?: "sm" | "md" | "lg" | "xl";
  /** Adds overflow-y-auto + flex-1 + min-h-0 to the body and max-h-[84vh] to the panel. */
  scrollable?: boolean;
  /** Prevents backdrop click and Escape from closing the dialog. */
  busy?: boolean;
  /**
   * Right-aligned footer buttons.
   * Wrap in a fragment: `footer={<><Cancel /><Save /></>}`
   */
  footer?: React.ReactNode;
  /**
   * Left side of the footer row (e.g. a Delete button).
   * When provided the footer becomes justify-between.
   */
  footerStart?: React.ReactNode;
  children: React.ReactNode;
  /** data-testid applied to the panel div. */
  testId?: string;
  /**
   * Extra `data-*` attributes spread onto the panel div. Use for state that
   * tests or styling need to read off the dialog root (e.g. the host modal's
   * `data-host-modal-mode`), which ModalShell otherwise has no way to expose.
   */
  dataAttributes?: Record<string, string>;
}

export function ModalShell({
  open,
  onClose,
  title,
  subtitle,
  icon: Icon,
  iconVariant = "accent",
  iconNode,
  maxWidth = "lg",
  scrollable = false,
  busy = false,
  footer,
  footerStart,
  children,
  testId,
  dataAttributes,
}: ModalShellProps) {
  const titleId = useId();
  const [visible, setVisible] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) requestAnimationFrame(() => setVisible(true));
    else setVisible(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, busy, onClose]);

  if (!open) return null;

  // Icon container — built-in accent/danger, or fully custom.
  const iconContainer = iconNode ?? (Icon ? (
    <div className={[
      "flex items-center justify-center w-8 h-8 rounded-lg shrink-0",
      iconVariant === "danger" ? "bg-status-error/10" : "bg-accent/10",
    ].join(" ")}>
      <Icon
        size={16}
        strokeWidth={1.8}
        className={iconVariant === "danger" ? "text-status-error" : "text-accent"}
        aria-hidden="true"
      />
    </div>
  ) : null);

  const hasFooter = footer !== undefined || footerStart !== undefined;

  return (
    <div
      ref={backdropRef}
      onClick={(e) => e.target === backdropRef.current && !busy && onClose()}
      className={[
        "fixed inset-0 z-50 flex items-start justify-center pt-[8vh]",
        "transition-[background-color,backdrop-filter] duration-[var(--duration-base)]",
        visible ? "bg-black/50 backdrop-blur-sm" : "bg-black/0 backdrop-blur-none",
      ].join(" ")}
    >
      <div
        data-testid={testId}
        {...dataAttributes}
        aria-modal="true"
        role="dialog"
        aria-labelledby={titleId}
        className={[
          `w-full ${MAX_W[maxWidth]} rounded-xl bg-bg-overlay border border-border shadow-[var(--shadow-lg)] flex flex-col`,
          scrollable ? "max-h-[84vh]" : "",
          "transition-[opacity,transform] duration-[var(--duration-slow)] ease-[var(--ease-expo-out)]",
          visible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-3",
        ].join(" ")}
      >
        {/* ── Header ── */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            {iconContainer}
            <div className="min-w-0">
              <h2
                id={titleId}
                className="text-[length:var(--text-lg)] font-semibold text-text-primary truncate"
              >
                {title}
              </h2>
              {subtitle && (
                <p className="text-[length:var(--text-xs)] text-text-muted mt-0.5 font-mono truncate">
                  {subtitle}
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="ml-3 p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-subtle transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 shrink-0"
          >
            <X size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>

        {/* ── Body ── */}
        <div className={[
          "px-6 py-4",
          scrollable ? "overflow-y-auto flex-1 min-h-0" : "",
        ].join(" ")}>
          {children}
        </div>

        {/* ── Footer ── */}
        {hasFooter && (
          <div className={[
            "px-6 py-3 flex items-center gap-2 border-t border-border shrink-0",
            footerStart ? "justify-between" : "justify-end",
          ].join(" ")}>
            {footerStart && <div>{footerStart}</div>}
            <div className="flex items-center gap-2">{footer}</div>
          </div>
        )}
      </div>
    </div>
  );
}
