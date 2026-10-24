// A progress toast tracks a download still in flight (#141): it must not be
// closable — closing it would leave no sign the file is still downloading — so
// it can only be minimized to a spinner glyph that keeps showing until the work
// is done. Regular toasts keep their close button.

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { Toaster } from "./Toaster";
import { toast, useToastStore } from "../../stores/toast-store";

describe("Toaster — progress toasts", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  it("offers minimize instead of close", () => {
    render(<Toaster />);
    act(() => {
      toast.progress('Downloading "big.log" to open…');
    });

    expect(screen.getByRole("button", { name: "Minimize" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("collapses to an activatable button, not a bare status region", () => {
    // Regression guard (#141 review): the collapsed control used to override its
    // own role with role="status", so assistive tech announced it as a status
    // region, not a button — hiding that it restores the toast. It must stay a
    // button with an accessible name.
    render(<Toaster />);
    act(() => {
      toast.progress('Downloading "big.log" to open…');
    });

    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));

    expect(
      screen.getByRole("button", { name: /show download progress/i }),
    ).toBeInTheDocument();
  });

  it("minimizes to a glyph that still reports progress, and restores on click", () => {
    render(<Toaster />);
    act(() => {
      toast.progress('Downloading "big.log" to open…');
    });

    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));

    const glyph = screen.getByRole("button", { name: /show download progress/i });
    expect(glyph).toHaveAttribute("data-minimized", "true");
    // The message stays in a live region (revealed on hover), so it's still announced.
    expect(screen.getByRole("status")).toHaveTextContent('Downloading "big.log" to open…');
    expect(useToastStore.getState().toasts).toHaveLength(1);

    fireEvent.click(glyph);
    expect(screen.getByRole("status")).not.toHaveAttribute("data-minimized");
    expect(screen.getByRole("button", { name: "Minimize" })).toBeInTheDocument();
  });

  it("disappears only when the work finishes, minimized or not", () => {
    render(<Toaster />);
    let id = "";
    act(() => {
      id = toast.progress("Downloading…");
    });
    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));

    act(() => {
      toast.dismiss(id);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps the close button on regular toasts", () => {
    render(<Toaster />);
    act(() => {
      toast.error("Permission denied");
    });

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});
