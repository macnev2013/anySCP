import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ── Tauri module mocks ───────────────────────────────────────────────────────
// ExplorerView imports `invoke` at module level and lazily imports the dialog
// plugin, the event channel, and the drag-drop webview API. Mock them all so
// the component mounts in jsdom without a real Tauri runtime.

const { invoke, dialogOpen, toastError } = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]) => [] as unknown),
  dialogOpen: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: dialogOpen }));
vi.mock("../../stores/toast-store", () => ({
  toast: { error: toastError, info: vi.fn(), success: vi.fn(), dismiss: vi.fn() },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    onDragDropEvent: vi.fn(async () => () => {}),
  }),
}));

import { Explorer } from "./Explorer";
import { createSftpProvider } from "../../providers/sftp-provider";
import { useSftpStore } from "../../stores/sftp-store";

const sftpProvider = () => createSftpProvider(SESSION_ID);

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

describe("Explorer — upload button (SFTP)", () => {
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

    render(<Explorer provider={sftpProvider()} />);
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

    render(<Explorer provider={sftpProvider()} />);
    fireEvent.click(await screen.findByTestId("explorer-upload"));

    await waitFor(() => expect(enqueueCall()).toBeDefined());
    expect(enqueueCall()?.[1]).toMatchObject({
      localPaths: ["/local/only.txt"],
      remoteDir: CURRENT_PATH,
    });
  });

  it("enqueues nothing when the picker is cancelled", async () => {
    dialogOpen.mockResolvedValue(null);

    render(<Explorer provider={sftpProvider()} />);
    fireEvent.click(await screen.findByTestId("explorer-upload"));

    await waitFor(() => expect(dialogOpen).toHaveBeenCalledTimes(1));
    // Give any (incorrect) follow-up invoke a chance to fire before asserting.
    await Promise.resolve();
    expect(enqueueCall()).toBeUndefined();
  });

  it("opens the folder picker in directory mode and enqueues the selected folders", async () => {
    dialogOpen.mockResolvedValue(["/local/projects", "/local/assets"]);

    render(<Explorer provider={sftpProvider()} />);
    fireEvent.click(await screen.findByTestId("explorer-upload-folder"));

    await waitFor(() => expect(dialogOpen).toHaveBeenCalledTimes(1));
    expect(dialogOpen).toHaveBeenCalledWith(
      expect.objectContaining({ directory: true, multiple: true }),
    );

    // A picked folder rides the same enqueue path as files; the backend
    // recreates it remotely and walks it recursively.
    await waitFor(() => expect(enqueueCall()).toBeDefined());
    expect(enqueueCall()?.[1]).toEqual({
      sftpSessionId: SESSION_ID,
      localPaths: ["/local/projects", "/local/assets"],
      remoteDir: CURRENT_PATH,
    });
  });

  it("enqueues nothing when the folder picker is cancelled", async () => {
    dialogOpen.mockResolvedValue(null);

    render(<Explorer provider={sftpProvider()} />);
    fireEvent.click(await screen.findByTestId("explorer-upload-folder"));

    await waitFor(() => expect(dialogOpen).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(enqueueCall()).toBeUndefined();
  });

  it("pauses on the overwrite dialog when an uploaded name already exists", async () => {
    // The destination already contains dup.txt.
    invoke.mockImplementation(async (...args: unknown[]) =>
      args[0] === "sftp_list_dir"
        ? [{
            name: "dup.txt",
            path: `${CURRENT_PATH}/dup.txt`,
            entry_type: "File",
            size: 1,
            permissions: 0,
            permissions_display: "",
            modified: 0,
            is_symlink: false,
          }]
        : []);
    dialogOpen.mockResolvedValue(["/local/dup.txt"]);

    render(<Explorer provider={sftpProvider()} />);
    fireEvent.click(await screen.findByTestId("explorer-upload"));

    // The confirm dialog appears and nothing is uploaded yet (no silent clobber).
    expect(await screen.findByTestId("explorer-overwrite-confirm-button")).toBeInTheDocument();
    expect(enqueueCall()).toBeUndefined();

    // Confirming proceeds with the upload.
    fireEvent.click(screen.getByTestId("explorer-overwrite-confirm-button"));
    await waitFor(() => expect(enqueueCall()).toBeDefined());
  });
});

describe("Explorer — create (SFTP)", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue([]);
    toastError.mockClear();
    useSftpStore.setState({ sessions: new Map(), activeSftpSessionId: null, clipboard: null });
    seedSession();
  });

  it("surfaces the backend error on a name collision instead of failing silently", async () => {
    invoke.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === "sftp_mkdir") throw { message: "File exists" };
      return [];
    });

    render(<Explorer provider={sftpProvider()} />);
    document.dispatchEvent(new CustomEvent("explorer:new-folder"));
    const input = await screen.findByTestId("explorer-new-folder-input");
    fireEvent.change(input, { target: { value: "temp" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls[0][0])).toContain("File exists");
  });

  it("blocks creating a file whose name already exists (no silent overwrite)", async () => {
    // The current dir already contains dup.txt.
    invoke.mockImplementation(async (...args: unknown[]) =>
      args[0] === "sftp_list_dir"
        ? [{
            name: "dup.txt",
            path: `${CURRENT_PATH}/dup.txt`,
            entry_type: "File",
            size: 1,
            permissions: 0,
            permissions_display: "",
            modified: 0,
            is_symlink: false,
          }]
        : []);

    render(<Explorer provider={sftpProvider()} />);
    // Wait for the listing to load so the collision guard can see dup.txt.
    await screen.findByTestId("explorer-entry-dup.txt");

    document.dispatchEvent(new CustomEvent("explorer:new-file"));
    const input = await screen.findByTestId("explorer-new-file-input");
    fireEvent.change(input, { target: { value: "dup.txt" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls[0][0])).toContain("already exists");
    // The create command must NOT have run.
    expect(invoke.mock.calls.some((c) => c[0] === "sftp_create_file")).toBe(false);
  });
});
