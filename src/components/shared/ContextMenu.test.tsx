import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ContextMenu } from "./ContextMenu";
import type { ContextMenuItem } from "./ContextMenu";

const ITEMS: ContextMenuItem[] = [
  { label: "Download", onClick: vi.fn() },
  { label: "Rename", onClick: vi.fn() },
];

/** Make the menu report a fixed rendered size (jsdom has no layout). */
function mockMenuSize(width: number, height: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

function menuStyle(): CSSStyleDeclaration {
  return (screen.getByRole("menu", { name: "Context menu" }) as HTMLElement).style;
}

describe("ContextMenu", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // jsdom default viewport is 1024x768; make it explicit for the math below.
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 768, configurable: true });
  });

  it("renders at the requested position when it fits", () => {
    mockMenuSize(200, 80);
    render(<ContextMenu items={ITEMS} position={{ x: 100, y: 100 }} onClose={vi.fn()} />);
    const style = menuStyle();
    expect(style.left).toBe("100px");
    expect(style.top).toBe("100px");
    expect(style.visibility).not.toBe("hidden");
  });

  it("clamps to the viewport using the menu's measured size", () => {
    mockMenuSize(200, 80);
    render(<ContextMenu items={ITEMS} position={{ x: 1000, y: 750 }} onClose={vi.fn()} />);
    const style = menuStyle();
    // 1024 - 200 - 8 margin = 816; 768 - 80 - 8 = 680
    expect(style.left).toBe("816px");
    expect(style.top).toBe("680px");
  });

  it("never clamps past the top-left margin", () => {
    mockMenuSize(2000, 2000); // larger than the viewport
    render(<ContextMenu items={ITEMS} position={{ x: 500, y: 500 }} onClose={vi.fn()} />);
    const style = menuStyle();
    expect(style.left).toBe("8px");
    expect(style.top).toBe("8px");
  });

  it("closes on window blur (click outside the webview)", () => {
    mockMenuSize(200, 80);
    const onClose = vi.fn();
    render(<ContextMenu items={ITEMS} position={{ x: 10, y: 10 }} onClose={onClose} />);
    fireEvent.blur(window);
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on window resize (fullscreen toggle)", () => {
    mockMenuSize(200, 80);
    const onClose = vi.fn();
    render(<ContextMenu items={ITEMS} position={{ x: 10, y: 10 }} onClose={onClose} />);
    fireEvent.resize(window);
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on outside mousedown but not on clicks inside the menu", () => {
    mockMenuSize(200, 80);
    const onClose = vi.fn();
    render(<ContextMenu items={ITEMS} position={{ x: 10, y: 10 }} onClose={onClose} />);
    fireEvent.mouseDown(screen.getByRole("menuitem", { name: "Download" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });

  it("runs the item action then closes", () => {
    mockMenuSize(200, 80);
    const onClose = vi.fn();
    const onClick = vi.fn();
    render(
      <ContextMenu
        items={[{ label: "Download", onClick }]}
        position={{ x: 10, y: 10 }}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Download" }));
    expect(onClick).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
