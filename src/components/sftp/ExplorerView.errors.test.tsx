import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

// ── Tauri module mocks ───────────────────────────────────────────────────────
// Same set as ExplorerView.upload.test.tsx: enough for the view to mount in jsdom.

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]) => [] as unknown),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
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
import { useToastStore } from "../../stores/toast-store";

const SESSION_ID = "sess-1";
const CURRENT_PATH = "/home/user";
const DENIED = "Permission denied";

/** Reject `command` with a backend-style string error; everything else succeeds. */
function failOn(command: string): void {
  invoke.mockImplementation(async (cmd: unknown) => {
    if (cmd === command) throw DENIED;
    return [];
  });
}

function errorToasts(): string[] {
  return useToastStore
    .getState()
    .toasts.filter((t) => t.kind === "error")
    .map((t) => t.message);
}

async function commitInlineName(testId: string, name: string): Promise<void> {
  const input = await screen.findByTestId(testId);
  fireEvent.change(input, { target: { value: name } });
  fireEvent.keyDown(input, { key: "Enter" });
}

describe("ExplorerView — failed actions surface an error (issue #151)", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue([]);
    useToastStore.setState({ toasts: [] });
    useSftpStore.setState({ sessions: new Map(), activeSftpSessionId: null, clipboard: null });
    const store = useSftpStore.getState();
    store.openSession(SESSION_ID, "ssh-1", "Test host", "user");
    store.setEntries(SESSION_ID, CURRENT_PATH, []);
  });

  it("shows why creating a folder failed", async () => {
    failOn("sftp_mkdir");
    render(<ExplorerView sessionId={SESSION_ID} />);

    act(() => {
      document.dispatchEvent(new Event("explorer:new-folder"));
    });
    await commitInlineName("explorer-new-folder-input", "logs");

    await waitFor(() =>
      expect(errorToasts()).toContain(`Couldn't create folder "logs": ${DENIED}`),
    );
  });

  it("shows why creating a file failed", async () => {
    failOn("sftp_create_file");
    render(<ExplorerView sessionId={SESSION_ID} />);

    act(() => {
      document.dispatchEvent(new Event("explorer:new-file"));
    });
    await commitInlineName("explorer-new-file-input", "notes.txt");

    await waitFor(() =>
      expect(errorToasts()).toContain(`Couldn't create file "notes.txt": ${DENIED}`),
    );
  });

  it("shows no error when the folder is created", async () => {
    render(<ExplorerView sessionId={SESSION_ID} />);

    act(() => {
      document.dispatchEvent(new Event("explorer:new-folder"));
    });
    await commitInlineName("explorer-new-folder-input", "logs");

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "sftp_mkdir",
        expect.objectContaining({ path: `${CURRENT_PATH}/logs` }),
      ),
    );
    expect(errorToasts()).toEqual([]);
  });
});
