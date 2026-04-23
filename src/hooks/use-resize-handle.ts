import { useCallback, useEffect, useRef } from "react";

interface UseResizeHandleOptions {
  direction: "horizontal" | "vertical";
  onResize: (delta: number) => void;
  onResizeEnd?: () => void;
}

/**
 * Returns props to spread on a drag handle element.
 * Tracks mouse movement and reports deltas.
 * Uses a full-screen overlay during drag to prevent xterm/WebGL canvases
 * from swallowing mouse events.
 */
export function useResizeHandle({ direction, onResize, onResizeEnd }: UseResizeHandleOptions) {
  const startPos = useRef(0);
  const isDragging = useRef(false);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const onResizeRef = useRef(onResize);
  const onResizeEndRef = useRef(onResizeEnd);
  onResizeRef.current = onResize;
  onResizeEndRef.current = onResizeEnd;

  // Safety cleanup: if component unmounts mid-drag, reset body styles + remove overlay
  useEffect(() => {
    return () => {
      if (isDragging.current) {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        overlayRef.current?.remove();
        overlayRef.current = null;
      }
    };
  }, []);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      startPos.current = direction === "horizontal" ? e.clientX : e.clientY;
      isDragging.current = true;

      // Create a full-screen transparent overlay to capture all mouse events
      // This prevents xterm's WebGL canvas from intercepting mousemove
      const overlay = document.createElement("div");
      overlay.style.cssText = `
        position: fixed; inset: 0; z-index: 9999;
        cursor: ${direction === "horizontal" ? "col-resize" : "row-resize"};
      `;
      document.body.appendChild(overlay);
      overlayRef.current = overlay;

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
        overlay.remove();
        overlayRef.current = null;
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
