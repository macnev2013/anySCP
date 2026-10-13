import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useToastStore, type ToastKind } from "../../stores/toast-store";

const ICONS: Record<ToastKind, React.ElementType> = {
  error: AlertCircle,
  success: CheckCircle2,
  info: Info,
};

// Each kind is colour-coded across the whole toast — red for errors, orange
// for info, green for success — so it reads at a glance, not just via the icon.
const ACCENTS: Record<ToastKind, string> = {
  error: "text-status-error",
  success: "text-status-connected",
  info: "text-status-connecting",
};

/** Border + tint for each kind. The tint is translucent, so it sits on an
 *  opaque surface (the outer toast) to stay readable over any page. */
const SURFACES: Record<ToastKind, { border: string; tint: string }> = {
  error: { border: "border-status-error/60", tint: "bg-status-error/20" },
  success: { border: "border-status-connected/60", tint: "bg-status-connected/20" },
  info: { border: "border-status-connecting/60", tint: "bg-status-connecting/20" },
};

/** Renders the stack of active toasts. Mount once at the app root. */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm w-[22rem] pointer-events-none">
      {toasts.map((t) => {
        const Icon = ICONS[t.kind];
        const surface = SURFACES[t.kind];
        return (
          <div
            key={t.id}
            role="alert"
            data-toast-kind={t.kind}
            className={`pointer-events-auto overflow-hidden rounded-xl bg-bg-overlay border ${surface.border} shadow-[var(--shadow-lg)] animate-in fade-in-0 slide-in-from-bottom-2 duration-[var(--duration-fast)]`}
          >
            <div className={`flex items-start gap-2.5 px-3.5 py-3 ${surface.tint}`}>
              <Icon size={16} strokeWidth={2} aria-hidden="true" className={`shrink-0 mt-0.5 ${ACCENTS[t.kind]}`} />
              <p className="flex-1 min-w-0 text-[length:var(--text-sm)] text-text-primary break-words">
                {t.message}
              </p>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss"
                className="shrink-0 -mr-1 -mt-0.5 p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-subtle transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X size={14} strokeWidth={2} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
