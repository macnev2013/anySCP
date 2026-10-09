import { describe, it, expect, beforeEach } from "vitest";
import { useLocalStore } from "./local-store";

beforeEach(() => {
  useLocalStore.setState({ panes: new Map() });
});

describe("local-store closePane", () => {
  it("removes a pane's browsing state (the leak fix on explorer-tab close)", () => {
    const key = "local:sftp1";
    useLocalStore.getState().setEntries(key, "/home/u", []);
    expect(useLocalStore.getState().panes.has(key)).toBe(true);

    useLocalStore.getState().closePane(key);
    expect(useLocalStore.getState().panes.has(key)).toBe(false);
  });

  it("only closes the named pane, leaving siblings intact", () => {
    useLocalStore.getState().setEntries("local:a", "/a", []);
    useLocalStore.getState().setEntries("local:b", "/b", []);

    useLocalStore.getState().closePane("local:a");

    expect(useLocalStore.getState().panes.has("local:a")).toBe(false);
    expect(useLocalStore.getState().panes.has("local:b")).toBe(true);
  });

  it("is a no-op for a pane that was never created (single-pane mode)", () => {
    useLocalStore.getState().closePane("local:never");
    expect(useLocalStore.getState().panes.size).toBe(0);
  });
});
