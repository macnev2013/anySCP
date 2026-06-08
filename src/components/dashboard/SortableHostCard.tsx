import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { SavedHost } from "../../types";
import { HostCard } from "./HostCard";

interface SortableHostCardProps {
  host: SavedHost;
  onConnect: (host: SavedHost) => void;
  onExplore: (host: SavedHost) => void;
  onEdit: (hostId: string) => void;
  onDelete: (hostId: string) => void;
  onDuplicate: (host: SavedHost) => void;
}

/**
 * Wraps {@link HostCard} with drag-and-drop reordering. The entire card is the
 * drag surface — the drag listeners sit on the wrapper. The dashboard's sensors
 * require a ~5px move (mouse) or a 250ms press (touch) before a drag begins, so
 * a plain click still falls through to the card's own connect/explore actions.
 */
export function SortableHostCard({ host, ...cardProps }: SortableHostCardProps) {
  const { listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: host.id });

  const style: React.CSSProperties = {
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
      // touch-none lets the TouchSensor own vertical gestures once a drag begins
      // instead of the browser scrolling the page.
      className="group/drag relative h-full touch-none"
      {...listeners}
    >
      <HostCard host={host} {...cardProps} />
    </div>
  );
}
