import { AlertCircle, CheckCircle2, Info, Loader2, Minus, X } from "lucide-react";
import { useToastStore, type Toast, type ToastKind } from "../../stores/toast-store";

const ICONS: Record<ToastKind, React.ElementType> = {
  error: AlertCircle,
  success: CheckCircle2,
  info: Info,
  progress: Loader2,
};

const ACCENTS: Record<ToastKind, string> = {
  error: "text-status-error",
  success: "text-status-connected",
  info: "text-accent",
  progress: "text-accent animate-spin",
};

const ICON_BUTTON_CLASS =
  "shrink-0 -mr-1 -mt-0.5 p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-subtle transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Renders the stack of active toasts. Mount once at the app root. */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  const setMinimized = useToastStore((s) => s.setMinimized);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm w-[22rem] pointer-events-none">
      {toasts.map((t) =>
        t.kind === "progress" && t.minimized ? (
          <MinimizedProgress key={t.id} toast={t} onRestore={() => setMinimized(t.id, false)} />
        ) : (
          <FullToast
            key={t.id}
            toast={t}
            onDismiss={() => dismiss(t.id)}
            onMinimize={() => setMinimized(t.id, true)}
          />
        ),
      )}
    </div>
  );
}

function FullToast({
  toast: t,
  onDismiss,
  onMinimize,
}: {
  toast: Toast;
  onDismiss: () => void;
  onMinimize: () => void;
}) {
  const Icon = ICONS[t.kind];
  // A progress toast tracks work still running, so it can't be closed — only
  // minimized; it goes away by itself when the work finishes.
  const isProgress = t.kind === "progress";
  return (
    <div
      role={isProgress ? "status" : "alert"}
      className="pointer-events-auto flex items-start gap-2.5 px-3.5 py-3 rounded-xl bg-bg-overlay border border-border shadow-[var(--shadow-lg)] animate-in fade-in-0 slide-in-from-bottom-2 duration-[var(--duration-fast)]"
    >
      <Icon size={16} strokeWidth={2} aria-hidden="true" className={`shrink-0 mt-0.5 ${ACCENTS[t.kind]}`} />
      <p className="flex-1 min-w-0 text-[length:var(--text-sm)] text-text-primary break-words">
        {t.message}
      </p>
      {isProgress ? (
        <button type="button" onClick={onMinimize} aria-label="Minimize" title="Minimize" className={ICON_BUTTON_CLASS}>
          <Minus size={14} strokeWidth={2} />
        </button>
      ) : (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className={ICON_BUTTON_CLASS}>
          <X size={14} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

/** A minimized progress toast: a small spinner glyph in the corner that keeps
 *  signalling the work is running. Hover/focus expands it to show the message;
 *  clicking restores the full toast. */
function MinimizedProgress({ toast: t, onRestore }: { toast: Toast; onRestore: () => void }) {
  return (
    <button
      type="button"
      role="status"
      data-minimized="true"
      onClick={onRestore}
      title="Show details"
      className="group pointer-events-auto self-end flex items-center rounded-full bg-bg-overlay border border-border shadow-[var(--shadow-lg)] p-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring animate-in fade-in-0 duration-[var(--duration-fast)]"
    >
      <Loader2 size={16} strokeWidth={2} aria-hidden="true" className="shrink-0 text-accent animate-spin" />
      <span className="max-w-0 overflow-hidden whitespace-nowrap opacity-0 text-[length:var(--text-sm)] text-text-primary transition-[max-width,opacity,padding] duration-[var(--duration-fast)] group-hover:max-w-[19rem] group-hover:opacity-100 group-hover:pl-2 group-hover:pr-1 group-focus-visible:max-w-[19rem] group-focus-visible:opacity-100 group-focus-visible:pl-2 group-focus-visible:pr-1 truncate">
        {t.message}
      </span>
    </button>
  );
}
