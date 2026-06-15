import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ── Tauri module mocks ───────────────────────────────────────────────────────
// ExplorerView imports `invoke` at module level and lazily imports the dialog
// plugin, the event channel, and the drag-drop webview API. Mock them all so
// the component mounts in jsdom without a real Tauri runtime.

const { invoke, dialogOpen } = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]) => [] as unknown),
  dialogOpen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: dialogOpen }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    onDragDropEvent: vi.fn(async () => () => {}),
  }),
}));

import { ExplorerView } from "./ExplorerView";
import { useSftpStore } from "../../stores/sftp-store";

const SESSION_ID = "sess-1";
const CURRENT_PATH = "/home/user";

function seedSession(): void {
  const store = useSftpStore.getState();
  store.openSession(SESSION_ID, "ssh-1", "Test host", "user");
  // Drive currentPath to a non-root dir so we can assert remoteDir precisely.
  store.setEntries(SESSION_ID, CURRENT_PATH, []);
}

/** Find the enqueue_upload invoke call, if any. */
function enqueueCall(): unknown[] | undefined {
  return invoke.mock.calls.find((c) => c[0] === "sftp_enqueue_upload");
}

describe("ExplorerView — upload button", () => {
  beforeEach(() => {
    invoke.mockClear();
    invoke.mockResolvedValue([]);
    dialogOpen.mockReset();
    // Fresh store between tests.
    useSftpStore.setState({ sessions: new Map(), activeSftpSessionId: null, clipboard: null });
    seedSession();
  });

  it("opens the native file picker and enqueues the selected files (issue #69)", async () => {
    dialogOpen.mockResolvedValue(["/local/a.txt", "/local/b.txt"]);

    render(<ExplorerView sessionId={SESSION_ID} />);
    fireEvent.click(await screen.findByTestId("explorer-upload"));

    await waitFor(() => expect(dialogOpen).toHaveBeenCalledTimes(1));
    expect(dialogOpen).toHaveBeenCalledWith(
      expect.objectContaining({ multiple: true }),
    );

    await waitFor(() => expect(enqueueCall()).toBeDefined());
    expect(enqueueCall()?.[1]).toEqual({
      sftpSessionId: SESSION_ID,
      localPaths: ["/local/a.txt", "/local/b.txt"],
      remoteDir: CURRENT_PATH,
    });
  });

  it("normalizes a single-path selection into a one-element array", async () => {
    dialogOpen.mockResolvedValue("/local/only.txt");

    render(<ExplorerView sessionId={SESSION_ID} />);
    fireEvent.click(await screen.findByTestId("explorer-upload"));

    await waitFor(() => expect(enqueueCall()).toBeDefined());
    expect(enqueueCall()?.[1]).toMatchObject({
      localPaths: ["/local/only.txt"],
      remoteDir: CURRENT_PATH,
    });
  });

  it("enqueues nothing when the picker is cancelled", async () => {
    dialogOpen.mockResolvedValue(null);

    render(<ExplorerView sessionId={SESSION_ID} />);
    fireEvent.click(await screen.findByTestId("explorer-upload"));

    await waitFor(() => expect(dialogOpen).toHaveBeenCalledTimes(1));
    // Give any (incorrect) follow-up invoke a chance to fire before asserting.
    await Promise.resolve();
    expect(enqueueCall()).toBeUndefined();
  });
});
