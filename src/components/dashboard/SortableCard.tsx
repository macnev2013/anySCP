import type { CSSProperties, ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

interface SortableCardProps {
  id: string;
  children: ReactNode;
}

/**
 * Generic drag-and-drop wrapper for dashboard cards (hosts, groups, S3) — one
 * shell replacing three near-identical per-card wrappers. The whole card is the
 * drag surface; the dashboard's sensors require a ~5px move (mouse), a 250ms
 * press (touch), or arrow keys once the card is focused (keyboard) before a drag
 * begins, so a plain click still falls through to the card's own actions.
 *
 * `attributes` wires keyboard accessibility (focusable + ARIA); `listeners` the
 * pointer/keyboard drag gestures. We render only the visual feedback (lift +
 * dim) while dragging — @dnd-kit drives the actual position.
 */
export function SortableCard({ id, children }: SortableCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    // Lift the dragged card above its neighbours and dim it so the drop target
    // reads clearly. @dnd-kit drives the position; we only style the feedback.
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      // touch-none lets the TouchSensor own the gesture once a drag begins
      // instead of the browser scrolling the page.
      className="relative h-full touch-none"
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
}
