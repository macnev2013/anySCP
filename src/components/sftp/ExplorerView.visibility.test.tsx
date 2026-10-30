import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ExplorerView } from "./ExplorerView";
import { useSftpStore } from "../../stores/sftp-store";
import { useSettingsStore } from "../../stores/settings-store";
import { toast } from "../../stores/toast-store";
import type { SftpEntry } from "../../types";

const { invoke, open } = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ onDragDropEvent: vi.fn(async () => () => {}) }) }));

function entry(name: string, entry_type: SftpEntry["entry_type"] = "File"): SftpEntry {
  return { name, path: `/home/${name}`, entry_type, size: 10, modified: null, permissions: 0o644, permissions_display: "rw-r--r--", is_symlink: false };
}
let listing: SftpEntry[];
const listCalls = () => invoke.mock.calls.filter(([cmd]) => /^(sftp|scp)_list_dir$/.test(cmd));

beforeEach(() => {
  vi.restoreAllMocks();
  invoke.mockReset();
  open.mockReset();
  vi.spyOn(toast, "success").mockReturnValue("toast");
  listing = [entry(".env"), entry(".config", "Directory"), entry("visible.txt")];
  invoke.mockImplementation(async (cmd: string) => {
    if (/^(sftp|scp)_list_dir$/.test(cmd)) return listing;
    return undefined;
  });
  useSettingsStore.setState({ loaded: true, explorerShowHiddenFiles: true });
  useSftpStore.setState({ sessions: new Map(), clipboard: null });
  useSftpStore.getState().openSession("s", "ssh", "Host", "user");
  useSftpStore.getState().setEntries("s", "/home", listing);
});

describe.each(["sftp", "scp"] as const)("%s hidden files", (transport) => {
  it("toggles only the current session, without listing or saving settings; remount retains its choice", async () => {
    const view = render(<ExplorerView sessionId="s" transport={transport} />);
    await waitFor(() => expect(listCalls()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Hide hidden files" }));
    expect(screen.queryByTestId("explorer-entry-.env")).not.toBeInTheDocument();
    expect(screen.getByTestId("explorer-entry-visible.txt")).toBeInTheDocument();
    expect(screen.getByTestId("explorer-hidden-files-toggle")).toHaveAttribute("aria-pressed", "false");
    expect(listCalls()).toHaveLength(1);
    expect(invoke.mock.calls.some(([cmd]) => cmd === "save_setting")).toBe(false);
    expect(useSftpStore.getState().sessions.get("s")?.entries).toEqual(listing);
    expect(useSettingsStore.getState().explorerShowHiddenFiles).toBe(true);
    view.unmount();
    render(<ExplorerView sessionId="s" transport={transport} />);
    expect(screen.queryByTestId("explorer-entry-.env")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("explorer-hidden-files-toggle"));
    expect(screen.getByTestId("explorer-entry-.env")).toBeInTheDocument();
  });

  it.each([false, true])("reports hidden file/folder creation only after backend success (failure=%s)", async (fail) => {
    useSettingsStore.setState({ explorerShowHiddenFiles: false });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd.endsWith("_list_dir")) return listing;
      if (fail && (cmd.endsWith("_create_file") || cmd.endsWith("_mkdir"))) throw new Error("denied");
    });
    render(<ExplorerView sessionId="s" transport={transport} />);
    await waitFor(() => expect(screen.getByTestId("explorer-new-file")).toBeEnabled());
    for (const kind of ["file", "folder"]) {
      fireEvent.click(screen.getByTestId(`explorer-new-${kind}`));
      const input = screen.getByTestId(`explorer-new-${kind}-input`);
      fireEvent.change(input, { target: { value: `.new-${kind}` } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(invoke.mock.calls.some(([cmd]) => cmd === `${transport}_${kind === "file" ? "create_file" : "mkdir"}`)).toBe(true));
    }
    if (fail) expect(toast.success).not.toHaveBeenCalled();
    else await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(2));
    expect(useSftpStore.getState().sessions.get("s")?.showHiddenFilesOverride).toBeNull();
  });

  it.each([false, true])("reports a rename becoming hidden only on success (failure=%s)", async (fail) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    useSettingsStore.setState({ explorerShowHiddenFiles: false });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd.endsWith("_list_dir")) return listing;
      if (cmd.endsWith("_rename")) {
        if (fail) throw new Error("denied");
        listing = [entry(".renamed")];
      }
    });
    render(<ExplorerView sessionId="s" transport={transport} />);
    const row = await screen.findByTestId("explorer-entry-visible.txt");
    fireEvent.keyDown(row, { key: "F2" });
    const input = screen.getByTestId("explorer-rename-input");
    fireEvent.change(input, { target: { value: ".renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(invoke.mock.calls.some(([cmd]) => cmd === `${transport}_rename`)).toBe(true));
    if (fail) expect(toast.success).not.toHaveBeenCalled();
    else {
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('Renamed to ".renamed"')));
      await waitFor(() => expect(screen.queryByTestId("explorer-entry-visible.txt")).not.toBeInTheDocument());
      expect(screen.queryByTestId("explorer-entry-.renamed")).not.toBeInTheDocument();
      expect(screen.getByLabelText("File list")).toHaveFocus();
    }
  });
});

it("waits for persisted settings without a flash of hidden rows", async () => {
  useSettingsStore.setState({ loaded: false });
  let resolveSettings!: (pairs: [string, string][]) => void;
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "load_all_settings") return new Promise<[string, string][]>((resolve) => { resolveSettings = resolve; });
    if (cmd === "sftp_list_dir") return listing;
  });
  const loadingSettings = useSettingsStore.getState().loadSettings();
  render(<ExplorerView sessionId="s" />);
  await waitFor(() => expect(listCalls()).toHaveLength(1));
  expect(screen.queryByTestId("explorer-entry-.env")).not.toBeInTheDocument();
  expect(screen.getByTestId("explorer-hidden-files-toggle")).toBeDisabled();
  await act(async () => { resolveSettings([["explorer_show_hidden_files", "false"], ["editors_seeded", "true"]]); await loadingSettings; });
  expect(screen.queryByTestId("explorer-entry-.env")).not.toBeInTheDocument();
  expect(screen.getByTestId("explorer-entry-visible.txt")).toBeInTheDocument();
});

it("updates untouched sessions with Settings while preserving an overridden session", async () => {
  useSftpStore.getState().openSession("other", "ssh2", "Other");
  useSftpStore.getState().setEntries("other", "/home", listing);
  const view = render(<><section data-testid="first"><ExplorerView sessionId="s" /></section><section data-testid="other"><ExplorerView sessionId="other" isActive={false} /></section></>);
  const first = within(screen.getByTestId("first")), other = within(screen.getByTestId("other"));
  fireEvent.click(first.getByTestId("explorer-hidden-files-toggle"));
  fireEvent.click(first.getByTestId("explorer-hidden-files-toggle"));
  act(() => useSettingsStore.getState().setExplorerShowHiddenFiles(false));
  expect(first.getByTestId("explorer-entry-.env")).toBeInTheDocument();
  expect(other.queryByTestId("explorer-entry-.env")).not.toBeInTheDocument();
  view.unmount();
});

it("preserves an explicit hidden clipboard for paste and sends entire directory paths to downloads", async () => {
  render(<ExplorerView sessionId="s" />);
  await waitFor(() => expect(listCalls()).toHaveLength(1));
  fireEvent.click(screen.getByTestId("explorer-entry-.env"));
  fireEvent.keyDown(screen.getByTestId("explorer-entry-.env"), { key: "c", ctrlKey: true });
  fireEvent.click(screen.getByTestId("explorer-hidden-files-toggle"));
  fireEvent.keyDown(screen.getByTestId("explorer-entry-visible.txt"), { key: "v", ctrlKey: true });
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("sftp_copy_entries", expect.objectContaining({ sourcePaths: ["/home/.env"] })));
  // Showing/hiding affects the parent listing, not recursive download contents.
  act(() => useSftpStore.getState().setEntries("s", "/home", [entry("folder", "Directory")]));
  open.mockResolvedValue("/local");
  fireEvent.contextMenu(screen.getByTestId("explorer-entry-folder"));
  fireEvent.click(screen.getByText("Download Folder"));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("sftp_enqueue_download", expect.objectContaining({ remotePaths: ["/home/folder"], localDir: "/local" })));
});

it("allows manually navigating into a hidden directory without changing visibility or path on toggle", async () => {
  useSettingsStore.setState({ explorerShowHiddenFiles: false });
  render(<ExplorerView sessionId="s" />);
  await waitFor(() => expect(screen.getByTestId("explorer-refresh")).toBeEnabled());
  fireEvent.click(screen.getByLabelText("Current path"));
  const input = screen.getByTestId("explorer-path-input");
  fireEvent.change(input, { target: { value: "/.config" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("sftp_list_dir", expect.objectContaining({ path: "/.config" })));
  expect(screen.getByTestId("explorer-entry-visible.txt")).toBeInTheDocument();
  fireEvent.click(screen.getByTestId("explorer-hidden-files-toggle"));
  expect(useSftpStore.getState().sessions.get("s")?.currentPath).toBe("/.config");
});


it("restores focus to the passive file-list target when a global default change removes the focused row", async () => {
  render(<ExplorerView sessionId="s" />);
  await waitFor(() => expect(screen.getByTestId("explorer-refresh")).toBeEnabled());
  act(() => screen.getByTestId("explorer-entry-.env").focus());
  act(() => useSettingsStore.setState({ explorerShowHiddenFiles: false }));
  expect(screen.getByLabelText("File list")).toHaveFocus();
});


it("uses a passive focus target after ordinary keyboard navigation, so Enter cannot toggle hidden files", async () => {
  invoke.mockImplementation(async (cmd: string, payload: { path?: string }) => {
    if (cmd === "sftp_list_dir") return payload.path === "/home/.config" ? [entry("child.txt")] : listing;
  });
  render(<ExplorerView sessionId="s" />);
  await waitFor(() => expect(screen.getByTestId("explorer-refresh")).toBeEnabled());
  const folder = screen.getByTestId("explorer-entry-.config");
  act(() => folder.focus());
  fireEvent.keyDown(folder, { key: "Enter" });
  await screen.findByTestId("explorer-entry-child.txt");
  const target = screen.getByLabelText("File list");
  expect(target).toHaveFocus();
  fireEvent.keyDown(target, { key: "Enter" });
  fireEvent.keyDown(target, { key: " " });
  expect(screen.getByTestId("explorer-hidden-files-toggle")).toHaveAttribute("aria-pressed", "true");
  expect(useSftpStore.getState().sessions.get("s")?.showHiddenFilesOverride).toBeNull();
});
