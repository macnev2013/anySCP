import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { UnifiedTabBar } from "../UnifiedTabBar";
import { useTabStore, pageTabId, type UnifiedTab } from "../../../stores/tab-store";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

// jsdom implements neither; the tab bar uses both for overflow handling.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.scrollBy = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const hostsTab: UnifiedTab = {
  type: "page",
  id: pageTabId("hosts"),
  label: "Hosts",
  page: "hosts",
};
const snippetsTab: UnifiedTab = {
  type: "page",
  id: pageTabId("snippets"),
  label: "Snippets",
  page: "snippets",
};

function seedTabs(tabs: UnifiedTab[], activeTabId: string) {
  useTabStore.setState({
    tabs: new Map(tabs.map((t) => [t.id, t])),
    tabOrder: tabs.map((t) => t.id),
    activeTabId,
  });
}

const middleClick = (el: Element) =>
  fireEvent(
    el,
    new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }),
  );

describe("UnifiedTabBar", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    seedTabs([hostsTab, snippetsTab], hostsTab.id);
  });

  it("closes a closeable tab on middle-click, like a browser", async () => {
    render(<UnifiedTabBar />);

    middleClick(screen.getByTestId(`tab-${snippetsTab.id}`));

    await waitFor(() =>
      expect(useTabStore.getState().tabs.has(snippetsTab.id)).toBe(false),
    );
  });

  it("ignores middle-click on the permanent hosts tab", async () => {
    render(<UnifiedTabBar />);

    middleClick(screen.getByTestId(`tab-${hostsTab.id}`));

    // Give the (would-be) async close path a beat, then confirm nothing happened.
    await Promise.resolve();
    expect(useTabStore.getState().tabs.has(hostsTab.id)).toBe(true);
  });

  it("shows no scroll chevrons when the strip fits", () => {
    render(<UnifiedTabBar />);
    expect(screen.queryByLabelText("Scroll tabs left")).toBeNull();
    expect(screen.queryByLabelText("Scroll tabs right")).toBeNull();
  });

  it("shows chevrons on overflow, greys out the exhausted side, and scrolls", async () => {
    // jsdom has no layout: fake a strip wider than its container.
    const proto = window.HTMLElement.prototype;
    Object.defineProperty(proto, "scrollWidth", { configurable: true, get: () => 500 });
    Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => 200 });
    try {
      render(<UnifiedTabBar />);

      const left = await screen.findByLabelText("Scroll tabs left");
      const right = await screen.findByLabelText("Scroll tabs right");
      // scrollLeft is 0 — nothing to the left yet, plenty to the right.
      expect(left).toBeDisabled();
      expect(right).toBeEnabled();

      fireEvent.click(right);
      expect(proto.scrollBy).toHaveBeenCalledWith(
        expect.objectContaining({ left: 150, behavior: "smooth" }),
      );
    } finally {
      delete (proto as unknown as Record<string, unknown>).scrollWidth;
      delete (proto as unknown as Record<string, unknown>).clientWidth;
    }
  });
});
