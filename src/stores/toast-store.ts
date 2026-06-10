import { create } from "zustand";

// A minimal transient-notification store. Used to surface action failures that
// would otherwise be invisible — most importantly editor-launch errors, which
// used to be swallowed silently (issues #12, #45, #56).

export type ToastKind = "error" | "success" | "info";

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
}

interface ToastState {
  toasts: Toast[];
  /** Show a toast; returns its id so it can be dismissed early. */
  show: (kind: ToastKind, message: string) => string;
  dismiss: (id: string) => void;
}

const AUTO_DISMISS_MS = 6000;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  show: (kind, message) => {
    const id = crypto.randomUUID();
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, AUTO_DISMISS_MS);
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Convenience facade for firing toasts from anywhere (incl. non-React code).
 *  The `show`-style methods return the toast id for early dismissal. */
export const toast = {
  error: (message: string) => useToastStore.getState().show("error", message),
  success: (message: string) => useToastStore.getState().show("success", message),
  info: (message: string) => useToastStore.getState().show("info", message),
  dismiss: (id: string) => useToastStore.getState().dismiss(id),
};
