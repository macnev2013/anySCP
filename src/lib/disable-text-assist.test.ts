import { afterEach, describe, expect, it } from "vitest";
import { disableTextAssist } from "./disable-text-assist";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("disableTextAssist", () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    document.body.innerHTML = "";
  });

  it("turns off autocorrect on inputs already in the DOM", () => {
    document.body.innerHTML = `<input id="a" /><textarea id="b"></textarea>`;
    stop = disableTextAssist();
    for (const id of ["a", "b"]) {
      const el = document.getElementById(id)!;
      expect(el.getAttribute("autocorrect")).toBe("off");
      expect(el.getAttribute("autocapitalize")).toBe("off");
      expect(el.getAttribute("spellcheck")).toBe("false");
    }
  });

  it("covers inputs added later, including nested ones (modals, portals)", async () => {
    stop = disableTextAssist();
    const wrap = document.createElement("div");
    wrap.innerHTML = `<form><label><input id="host" /></label></form>`;
    document.body.appendChild(wrap);
    await flush();
    const el = document.getElementById("host")!;
    expect(el.getAttribute("autocorrect")).toBe("off");
    expect(el.getAttribute("autocapitalize")).toBe("off");
  });

  it("leaves an explicit opt-in alone", async () => {
    stop = disableTextAssist();
    document.body.innerHTML = `<textarea id="notes" spellcheck="true"></textarea>`;
    await flush();
    const el = document.getElementById("notes")!;
    expect(el.getAttribute("spellcheck")).toBe("true");
    expect(el.getAttribute("autocorrect")).toBe("off");
  });
});
