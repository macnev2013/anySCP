import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

// Issue #137: a bucket with ~180k keys never opened because s3_list_objects
// walked every page before returning. Listings now arrive a page at a time and
// the browser offers "Load more" while a continuation token remains.

// ── Tauri module mocks ───────────────────────────────────────────────────────
// S3Browser lazily imports invoke, the event channel and the drag-drop webview
// API. Mock them all so the component mounts in jsdom.

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]) => undefined as unknown),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    onDragDropEvent: vi.fn(async () => () => {}),
  }),
}));

import { S3Browser } from "../S3Browser";
import { useSettingsStore } from "../../../stores/settings-store";
import { useS3Store } from "../../../stores/s3-store";
import type { S3Entry, S3ListResult } from "../../../types";

const SESSION_ID = "s3-sess";

function file(name: string): S3Entry {
  return { name, key: name, entry_type: "File", size: 1, last_modified: null, storage_class: null };
}

function page(names: string[], token: string | null): S3ListResult {
  return {
    entries: names.map(file),
    continuation_token: token,
    is_truncated: token !== null,
    prefix: "",
  };
}

/** Calls to s3_list_objects, in order, as their argument objects. */
function listCalls(): Record<string, unknown>[] {
  return invoke.mock.calls
    .filter((c) => c[0] === "s3_list_objects")
    .map((c) => c[1] as Record<string, unknown>);
}

/** Route s3_list_objects by continuation token; everything else resolves undefined. */
function serveListing(pages: Record<string, S3ListResult>): void {
  invoke.mockImplementation(async (...args: unknown[]) => {
    const [cmd, payload] = args as [string, { continuationToken: string | null }];
    if (cmd !== "s3_list_objects") return undefined;
    return pages[payload.continuationToken ?? "first"];
  });
}

describe("S3Browser — paged listings (issue #137)", () => {
  beforeEach(() => {
    invoke.mockReset();
    useSettingsStore.setState({ loaded: true, explorerShowHiddenFiles: true });
    useS3Store.setState({ sessions: new Map(), activeS3SessionId: null });
    const store = useS3Store.getState();
    store.openSession(SESSION_ID, "minio");
    store.setCurrentBucket(SESSION_ID, "big-bucket");
  });

  it("requests only the first page and offers Load more when truncated", async () => {
    serveListing({ first: page(["a.txt", "b.txt"], "tok-1") });

    render(<S3Browser sessionId={SESSION_ID} />);

    expect(await screen.findByTestId("s3-load-more")).toBeInTheDocument();
    expect(screen.getByTestId("s3-load-more-count")).toHaveTextContent("Loaded 2 items · Showing 2 · Hidden 0");
    expect(listCalls()).toEqual([
      { s3SessionId: SESSION_ID, prefix: "", continuationToken: null },
    ]);
  });

  it("Load more fetches the next page with the token and appends it", async () => {
    serveListing({
      first: page(["a.txt", "b.txt"], "tok-1"),
      "tok-1": page(["c.txt"], null),
    });

    render(<S3Browser sessionId={SESSION_ID} />);
    fireEvent.click(await screen.findByTestId("s3-load-more-button"));

    await waitFor(() =>
      expect(screen.queryByTestId("s3-load-more")).not.toBeInTheDocument(),
    );
    expect(listCalls()[1]).toEqual({
      s3SessionId: SESSION_ID,
      prefix: "",
      continuationToken: "tok-1",
    });
    expect(
      useS3Store.getState().sessions.get(SESSION_ID)!.entries.map((e) => e.name),
    ).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  it("shows no Load more footer for a complete listing", async () => {
    serveListing({ first: page(["only.txt"], null) });

    render(<S3Browser sessionId={SESSION_ID} />);

    await waitFor(() => expect(listCalls()).toHaveLength(1));
    await waitFor(() =>
      expect(useS3Store.getState().sessions.get(SESSION_ID)!.entries).toHaveLength(1),
    );
    expect(screen.queryByTestId("s3-load-more")).not.toBeInTheDocument();
  });
});


describe("S3 visibility and paging", () => {
  beforeEach(() => {
    invoke.mockReset();
    useSettingsStore.setState({ loaded: true, explorerShowHiddenFiles: false });
    useS3Store.setState({ sessions: new Map() });
    useS3Store.getState().openSession(SESSION_ID, "S3");
    useS3Store.getState().setCurrentBucket(SESSION_ID, "bucket");
  });

  it("keeps Load more for an all-hidden page and filters later pages without fetching automatically", async () => {
    serveListing({ first: page([".env", ".git/"], "next"), next: page([".secret", "visible.txt"], null) });
    render(<S3Browser sessionId={SESSION_ID} />);
    expect(await screen.findByText("Hidden items are not shown")).toBeInTheDocument();
    expect(screen.getByTestId("s3-load-more-count")).toHaveTextContent("Loaded 2 items · Showing 0 · Hidden 2 — more available");
    expect(listCalls()).toHaveLength(1);
    fireEvent.click(screen.getByTestId("s3-load-more-button"));
    expect(await screen.findByTestId("explorer-entry-visible.txt")).toBeInTheDocument();
    expect(screen.queryByTestId("explorer-entry-.secret")).not.toBeInTheDocument();
    expect(screen.getByTestId("s3-load-more-count")).toHaveTextContent("Loaded 4 items · Showing 1 · Hidden 3");
    fireEvent.click(screen.getByTestId("explorer-hidden-files-toggle"));
    expect(screen.getByTestId("explorer-entry-.secret")).toBeInTheDocument();
    expect(listCalls()).toHaveLength(2);
    expect(useS3Store.getState().sessions.get(SESSION_ID)?.entries).toHaveLength(4);
    expect(invoke.mock.calls.some(([cmd]) => cmd === "save_setting")).toBe(false);
  });

  it("waits for settings before rendering rows or enabling the toggle", async () => {
    useSettingsStore.setState({ loaded: false, explorerShowHiddenFiles: true });
    serveListing({ first: page([".env", "visible.txt"], null) });
    render(<S3Browser sessionId={SESSION_ID} />);
    await waitFor(() => expect(useS3Store.getState().sessions.get(SESSION_ID)?.entries).toHaveLength(2));
    expect(screen.queryByTestId("explorer-entry-.env")).not.toBeInTheDocument();
    expect(screen.getByTestId("explorer-hidden-files-toggle")).toBeDisabled();
    act(() => useSettingsStore.setState({ loaded: true, explorerShowHiddenFiles: false }));
    expect(screen.queryByTestId("explorer-entry-.env")).not.toBeInTheDocument();
    expect(screen.getByTestId("explorer-entry-visible.txt")).toBeInTheDocument();
  });

  it("does not show a zero-count footer for a genuinely empty prefix", async () => {
    serveListing({ first: page([], null) });
    render(<S3Browser sessionId={SESSION_ID} />);
    expect(await screen.findByText("This folder is empty")).toBeInTheDocument();
    expect(screen.queryByTestId("s3-load-more-count")).not.toBeInTheDocument();
  });

  it("does not filter bucket names", async () => {
    useS3Store.getState().openSession("buckets", "S3");
    invoke.mockResolvedValue([{ name: ".bucket", creation_date: null }]);
    render(<S3Browser sessionId="buckets" />);
    expect(await screen.findByText(".bucket")).toBeInTheDocument();
  });
});

describe("S3 hidden creation feedback", () => {
  it.each([false, true])("reports hidden creation only after backend success (failure=%s)", async (fail) => {
    const { toast } = await import("../../../stores/toast-store");
    const success = vi.spyOn(toast, "success").mockReturnValue("toast");
    useSettingsStore.setState({ loaded: true, explorerShowHiddenFiles: false });
    useS3Store.setState({ sessions: new Map() });
    useS3Store.getState().openSession(SESSION_ID, "S3");
    useS3Store.getState().setCurrentBucket(SESSION_ID, "bucket");
    invoke.mockReset();
    invoke.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0];
      if (cmd === "s3_list_objects") return page([], null);
      if (fail && (cmd === "s3_create_file" || cmd === "s3_create_folder")) throw new Error("denied");
    });
    render(<S3Browser sessionId={SESSION_ID} />);
    await waitFor(() => expect(screen.getByTestId("explorer-new-file")).toBeEnabled());
    for (const kind of ["file", "folder"]) {
      fireEvent.click(screen.getByTestId(`explorer-new-${kind}`));
      const input = screen.getByTestId(`explorer-new-${kind}-input`);
      fireEvent.change(input, { target: { value: `.new-${kind}` } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(invoke.mock.calls.some(([cmd]) => cmd === `s3_create_${kind}`)).toBe(true));
    }
    if (fail) expect(success).not.toHaveBeenCalled();
    else await waitFor(() => expect(success).toHaveBeenCalledTimes(2));
    success.mockRestore();
  });
});
