import { describe, it, expect } from "vitest";
import {
  permissionsStringToOctal,
  octalToPermissionBits,
  permissionBitsToOctal,
  octalToString,
  octalToPermissionsString,
  sanitizeOctalInput,
  octalInputToValue,
} from "./permissions";

describe("permissionsStringToOctal", () => {
  it("parses rwx triples", () => {
    expect(permissionsStringToOctal("rwxr-xr-x")).toBe(0o755);
    expect(permissionsStringToOctal("rw-r--r--")).toBe(0o644);
    expect(permissionsStringToOctal("rwxrwxrwx")).toBe(0o777);
    expect(permissionsStringToOctal("---------")).toBe(0);
  });

  it("drops a leading file-type character (10-char form)", () => {
    expect(permissionsStringToOctal("drwxr-xr-x")).toBe(0o755);
    expect(permissionsStringToOctal("-rw-r--r--")).toBe(0o644);
    expect(permissionsStringToOctal("lrwxrwxrwx")).toBe(0o777);
  });

  it("stays within the lower 9 bits even for special-bit glyphs", () => {
    // 's'/'t' count as a set execute bit; special bits are NOT recovered here.
    expect(permissionsStringToOctal("rwsr-xr-x")).toBe(0o755);
    expect(permissionsStringToOctal("rwxr-xr-t")).toBe(0o755);
    expect(permissionsStringToOctal("rwxrwxrwx")).toBeLessThanOrEqual(0o777);
  });
});

describe("octal <-> bits round-trip", () => {
  it("is the identity for every value in 0..0o777", () => {
    for (let m = 0; m <= 0o777; m++) {
      expect(permissionBitsToOctal(octalToPermissionBits(m))).toBe(m);
    }
  });

  it("maps individual bits to the right checkboxes", () => {
    expect(octalToPermissionBits(0o640)).toEqual({
      ownerR: true,
      ownerW: true,
      ownerX: false,
      groupR: true,
      groupW: false,
      groupX: false,
      otherR: false,
      otherW: false,
      otherX: false,
    });
  });
});

describe("octalToString / octalToPermissionsString", () => {
  it("formats a 3-digit octal string", () => {
    expect(octalToString(0o755)).toBe("755");
    expect(octalToString(0)).toBe("000");
    expect(octalToString(0o7)).toBe("007");
  });

  it("masks off bits above the lower 9", () => {
    expect(octalToString(0o4755)).toBe("755");
  });

  it("renders the rwx form", () => {
    expect(octalToPermissionsString(0o755)).toBe("rwxr-xr-x");
    expect(octalToPermissionsString(0o644)).toBe("rw-r--r--");
    expect(octalToPermissionsString(0)).toBe("---------");
  });
});

describe("sanitizeOctalInput (the '0755' paste regression)", () => {
  it("keeps the last three octal digits", () => {
    expect(sanitizeOctalInput("0755")).toBe("755"); // was truncated to "075"
    expect(sanitizeOctalInput("755")).toBe("755");
    expect(sanitizeOctalInput("4755")).toBe("755");
    expect(sanitizeOctalInput("0644")).toBe("644");
  });

  it("strips non-octal characters", () => {
    expect(sanitizeOctalInput("rwx755")).toBe("755");
    expect(sanitizeOctalInput("89")).toBe(""); // 8 and 9 are not octal
    expect(sanitizeOctalInput("7a8b9")).toBe("7"); // only 7 survives
  });

  it("handles short and empty input", () => {
    expect(sanitizeOctalInput("")).toBe("");
    expect(sanitizeOctalInput("7")).toBe("7");
    expect(sanitizeOctalInput("0")).toBe("0");
  });
});

describe("octalInputToValue", () => {
  it("parses the leading-zero form as the intended mode", () => {
    expect(octalInputToValue("0755")).toBe(0o755); // not 0o075
    expect(octalInputToValue("644")).toBe(0o644);
  });

  it("returns null for empty / all-invalid input", () => {
    expect(octalInputToValue("")).toBeNull();
    expect(octalInputToValue("xyz")).toBeNull();
    expect(octalInputToValue("89")).toBeNull();
  });

  it("masks to the lower 9 bits", () => {
    expect(octalInputToValue("777")).toBe(0o777);
  });
});
