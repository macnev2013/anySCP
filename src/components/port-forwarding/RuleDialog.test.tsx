// Guards the tunnel destination (issue #138): a rule can forward to any host
// reachable from the SSH server, not just the server itself. The dialog used to
// hardcode remote_host to "localhost", so the backend's support was unreachable.

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RuleDialog } from "./PortForwardingPage";
import type { PortForwardRule, SavedHost } from "../../types";

const host = {
  id: "h1",
  label: "bastion",
  host: "bastion.example.com",
  port: 22,
  username: "me",
} as SavedHost;

const existingRule: PortForwardRule = {
  id: "r1",
  host_id: "h1",
  label: "db",
  description: null,
  forward_type: "Local",
  bind_address: "127.0.0.1",
  local_port: 15432,
  remote_host: "db.internal",
  remote_port: 5432,
  auto_start: false,
  enabled: true,
  last_used_at: null,
  total_bytes: 0,
  created_at: "2026-01-01T00:00:00Z",
};

function fillPorts(local: string, remote: string): void {
  fireEvent.change(screen.getByTestId("rule-local-port"), { target: { value: local } });
  fireEvent.change(screen.getByTestId("rule-remote-port"), { target: { value: remote } });
}

describe("RuleDialog — destination host", () => {
  it("defaults to localhost, so existing behaviour is unchanged", () => {
    const onSubmit = vi.fn();
    render(<RuleDialog hosts={[host]} onSubmit={onSubmit} onCancel={vi.fn()} />);

    expect(screen.getByTestId("rule-remote-host")).toHaveValue("localhost");
    fillPorts("15432", "5432");
    fireEvent.click(screen.getByTestId("rule-dialog-save"));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ remote_host: "localhost", remote_port: 5432 }),
    );
  });

  it("forwards to another host reachable from the SSH server", () => {
    const onSubmit = vi.fn();
    render(<RuleDialog hosts={[host]} onSubmit={onSubmit} onCancel={vi.fn()} />);

    fillPorts("15432", "5432");
    fireEvent.change(screen.getByTestId("rule-remote-host"), {
      target: { value: "  10.0.0.12  " },
    });
    fireEvent.click(screen.getByTestId("rule-dialog-save"));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ remote_host: "10.0.0.12", remote_port: 5432 }),
    );
  });

  it("keeps a saved destination when editing", () => {
    const onSubmit = vi.fn();
    render(<RuleDialog hosts={[host]} rule={existingRule} onSubmit={onSubmit} onCancel={vi.fn()} />);

    expect(screen.getByTestId("rule-remote-host")).toHaveValue("db.internal");
    fireEvent.click(screen.getByTestId("rule-dialog-save"));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ remote_host: "db.internal" }),
    );
  });

  it.each([
    ["empty", ""],
    ["containing spaces", "db internal"],
  ])("blocks saving with a destination %s", (_case, value) => {
    render(<RuleDialog hosts={[host]} onSubmit={vi.fn()} onCancel={vi.fn()} />);

    fillPorts("15432", "5432");
    fireEvent.change(screen.getByTestId("rule-remote-host"), { target: { value } });

    expect(screen.getByTestId("rule-dialog-save")).toBeDisabled();
  });
});
