import { useRef } from "react";

export interface ModalBackdropProps {
  onClose: () => void;
  /** When true, a backdrop click won't close (e.g. while saving/connecting). */
  closeDisabled?: boolean;
  /** Overlay classes: positioning, background, blur, transitions. */
  className?: string;
  children: React.ReactNode;
}

/**
 * The dimmed overlay behind a modal, owning the one correct close rule: a click
 * closes only when the press BOTH starts and ends on the backdrop itself. A DOM
 * `click` fires on the common ancestor of mousedown and mouseup, so a drag that
 * starts inside the panel (e.g. selecting text in a field) and releases on the
 * backdrop would otherwise count as an outside click and discard the input.
 *
 * Every modal should wrap its panel in this rather than hand-rolling an onClick,
 * so the bug can't come back.
 */
export function ModalBackdrop({ onClose, closeDisabled = false, className, children }: ModalBackdropProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const pressedOnBackdrop = useRef(false);

  return (
    <div
      ref={backdropRef}
      onMouseDown={(e) => { pressedOnBackdrop.current = e.target === backdropRef.current; }}
      onMouseUp={(e) => {
        if (e.target === backdropRef.current && pressedOnBackdrop.current && !closeDisabled) onClose();
        pressedOnBackdrop.current = false;
      }}
      className={className}
    >
      {children}
    </div>
  );
}
