import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { HostGroup } from "../../types";
import { GroupCard } from "./GroupCard";

interface SortableGroupCardProps {
  group: HostGroup;
  hostCount: number;
  isSelected: boolean;
  onSelect: (groupId: string) => void;
  onDelete: (groupId: string) => void;
}

/**
 * Wraps {@link GroupCard} with drag-and-drop reordering — the mirror of
 * {@link SortableHostCard}. The whole card is the drag surface; the dashboard's
 * sensors require a ~5px move (mouse) or a 250ms press (touch) before a drag
 * begins, so a plain click still falls through to the card's select action.
 */
export function SortableGroupCard({ group, ...cardProps }: SortableGroupCardProps) {
  const { listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: group.id });

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
      // touch-none lets the TouchSensor own the gesture once a drag begins
      // instead of the browser scrolling the page.
      className="relative h-full touch-none"
      {...listeners}
    >
      <GroupCard group={group} {...cardProps} />
    </div>
  );
}
