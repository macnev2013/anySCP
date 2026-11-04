import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

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
    useS3Store.setState({ sessions: new Map(), activeS3SessionId: null });
    const store = useS3Store.getState();
    store.openSession(SESSION_ID, "minio");
    store.setCurrentBucket(SESSION_ID, "big-bucket");
  });

  it("requests only the first page and offers Load more when truncated", async () => {
    serveListing({ first: page(["a.txt", "b.txt"], "tok-1") });

    render(<S3Browser sessionId={SESSION_ID} />);

    expect(await screen.findByTestId("s3-load-more")).toBeInTheDocument();
    expect(screen.getByTestId("s3-load-more-count")).toHaveTextContent("Showing 2 items");
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
