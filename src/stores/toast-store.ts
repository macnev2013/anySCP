import { create } from "zustand";

// A minimal transient-notification store. Used to surface action failures that
// would otherwise be invisible — most importantly editor-launch errors, which
// used to be swallowed silently (issues #12, #45, #56).

// "progress" marks a long-running operation: it shows a spinner and stays up
// until the caller dismisses it, instead of auto-dismissing. The user can't
// close it (that would hide a download still in flight), only minimize it.
export type ToastKind = "error" | "success" | "info" | "progress";

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  /** Progress toasts only: collapsed to a small spinner glyph by the user. */
  minimized?: boolean;
}

interface ToastState {
  toasts: Toast[];
  /** Show a toast; returns its id so it can be dismissed early. */
  show: (kind: ToastKind, message: string) => string;
  dismiss: (id: string) => void;
  setMinimized: (id: string, minimized: boolean) => void;
}

const AUTO_DISMISS_MS = 6000;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  show: (kind, message) => {
    const id = crypto.randomUUID();
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    if (kind === "progress") return id;
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, AUTO_DISMISS_MS);
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setMinimized: (id, minimized) =>
    set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, minimized } : t)) })),
}));

/** Convenience facade for firing toasts from anywhere (incl. non-React code).
 *  The `show`-style methods return the toast id for early dismissal. */
export const toast = {
  error: (message: string) => useToastStore.getState().show("error", message),
  success: (message: string) => useToastStore.getState().show("success", message),
  info: (message: string) => useToastStore.getState().show("info", message),
  /** Stays visible until `dismiss`ed with the returned id. */
  progress: (message: string) => useToastStore.getState().show("progress", message),
  dismiss: (id: string) => useToastStore.getState().dismiss(id),
};
