// Toasts are colour-coded by kind (red error / orange info / green success)
// across the whole toast, not just the icon.

import { describe, it, expect, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { Toaster } from "./Toaster";
import { toast, useToastStore } from "../../stores/toast-store";

describe("Toaster colours", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  it.each([
    ["error", "status-error"],
    ["info", "status-connecting"],
    ["success", "status-connected"],
  ] as const)("tints a %s toast with %s", (kind, token) => {
    const { container } = render(<Toaster />);
    act(() => {
      toast[kind]("hello");
    });

    const el = container.querySelector(`[data-toast-kind='${kind}']`) as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.className).toContain(`border-${token}/`);
    expect((el.firstElementChild as HTMLElement).className).toContain(`bg-${token}/`);
  });
});
