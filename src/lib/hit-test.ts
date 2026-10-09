// Pointer hit-testing that sees THROUGH fixed overlays. `elementFromPoint`
// returns only the topmost element, so an overlay (e.g. the transfer popover at
// z-50) would defeat drag hit-testing. `elementsFromPoint` returns the whole
// front-to-back stack, so we skip overlays to the first `selector` match
// beneath (`pointer-events: none` elements like the drag ghost are excluded).
export function closestAtPoint(x: number, y: number, selector: string): HTMLElement | null {
  for (const el of document.elementsFromPoint(x, y)) {
    const hit = (el as HTMLElement).closest?.(selector);
    if (hit) return hit as HTMLElement;
  }
  return null;
}
