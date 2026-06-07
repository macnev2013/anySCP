import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Unmount React trees between tests so the DOM/listeners don't leak across specs.
afterEach(() => {
  cleanup();
});
