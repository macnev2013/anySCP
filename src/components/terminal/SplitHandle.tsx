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
        relative flex-shrink-0 group
        ${isHorizontal ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize"}
      `}
      {...handle}
    >
      {/* Visible bar */}
      <div
        className={`
          absolute bg-border group-hover:bg-accent/50 transition-colors duration-[var(--duration-fast)]
          ${isHorizontal ? "inset-y-0 left-0 w-px" : "inset-x-0 top-0 h-px"}
        `}
      />
      {/* Wider hit target */}
      <div
        className={`
          absolute
          ${isHorizontal ? "inset-y-0 -left-1 w-3" : "inset-x-0 -top-1 h-3"}
        `}
      />
    </div>
  );
}
