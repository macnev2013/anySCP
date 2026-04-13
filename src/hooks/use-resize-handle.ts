import { useCallback, useRef, useEffect } from "react";

interface UseResizeHandleOptions {
  direction: "horizontal" | "vertical";
  onResize: (delta: number) => void;
  onResizeEnd?: () => void;
}

/**
 * Returns props to spread on a drag handle element.
 * Tracks mouse movement and reports deltas.
 */
export function useResizeHandle({ direction, onResize, onResizeEnd }: UseResizeHandleOptions) {
  const startPos = useRef(0);
  const isDragging = useRef(false);

  // Keep refs to latest callbacks so the drag closure always calls the current version.
  // Without this, the mousemove closure captures a stale onResize that reads an old ratio.
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const onResizeEndRef = useRef(onResizeEnd);
  onResizeEndRef.current = onResizeEnd;

  // Safety cleanup: if component unmounts mid-drag, reset body styles
  useEffect(() => {
    return () => {
      if (isDragging.current) {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };
  }, []);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startPos.current = direction === "horizontal" ? e.clientX : e.clientY;
      isDragging.current = true;

      const onMouseMove = (moveEvent: MouseEvent) => {
        const current = direction === "horizontal" ? moveEvent.clientX : moveEvent.clientY;
        const delta = current - startPos.current;
        startPos.current = current;
        onResizeRef.current(delta);
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        isDragging.current = false;
        onResizeEndRef.current?.();
      };

      document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [direction],
  );

  return { onMouseDown };
}
