import { create } from "zustand";

/**
 * Transient highlight target for a CROSS-pane drag. The drag runs in the source
 * pane's component, but the drop target (a folder or ".." row) lives in the
 * OTHER pane's component, which can't see the source's local drag state. The
 * source writes {paneKey, entryId} here while hovering the sibling; the target
 * pane highlights the match. Same-pane highlighting stays local (`dragOverId`).
 */
interface DragState {
  target: { paneKey: string; entryId: string } | null;
  setTarget: (t: { paneKey: string; entryId: string } | null) => void;
}

export const useDragStore = create<DragState>((set) => ({
  target: null,
  setTarget: (target) => set({ target }),
}));
