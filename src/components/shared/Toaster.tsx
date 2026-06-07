import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useToastStore, type ToastKind } from "../../stores/toast-store";

const ICONS: Record<ToastKind, React.ElementType> = {
  error: AlertCircle,
  success: CheckCircle2,
  info: Info,
};

const ACCENTS: Record<ToastKind, string> = {
  error: "text-status-error",
  success: "text-status-connected",
  info: "text-accent",
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
        return (
          <div
            key={t.id}
            role="alert"
            className="pointer-events-auto flex items-start gap-2.5 px-3.5 py-3 rounded-xl bg-bg-overlay border border-border shadow-[var(--shadow-lg)] animate-in fade-in-0 slide-in-from-bottom-2 duration-[var(--duration-fast)]"
          >
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
        );
      })}
    </div>
  );
}
