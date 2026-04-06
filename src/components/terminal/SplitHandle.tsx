import { useResizeHandle } from "../../hooks/use-resize-handle";
import type { SplitDirection } from "../../types";

interface SplitHandleProps {
  direction: SplitDirection;
  onResize: (delta: number) => void;
}

export function SplitHandle({ direction, onResize }: SplitHandleProps) {
  const handle = useResizeHandle({ direction, onResize });

  const isHorizontal = direction === "horizontal";

  return (
    <div
      className={`
        relative z-10 flex-shrink-0
        ${isHorizontal ? "w-2 cursor-col-resize" : "h-2 cursor-row-resize"}
      `}
      {...handle}
    >
    </div>
  );
}
