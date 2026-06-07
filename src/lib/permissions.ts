// Unix permission bit-arithmetic for the File Properties dialog.
//
// All conversions operate on the lower 9 permission bits (rwx for owner /
// group / other). Special bits (setuid/setgid/sticky) are out of scope for the
// chmod UI — the octal input is constrained to 000–777.
//
//   owner:  bit 8 (r), 7 (w), 6 (x)
//   group:  bit 5 (r), 4 (w), 3 (x)
//   other:  bit 2 (r), 1 (w), 0 (x)

export interface PermissionBits {
  ownerR: boolean;
  ownerW: boolean;
  ownerX: boolean;
  groupR: boolean;
  groupW: boolean;
  groupX: boolean;
  otherR: boolean;
  otherW: boolean;
  otherX: boolean;
}

/** Parse an `rwxr-xr-x` (or `drwxr-xr-x` with a leading type char) string into
 *  its 9-bit octal value. Unknown characters are treated as "unset".
 *
 *  Note: the special-bit glyphs 's'/'S'/'t'/'T' set the underlying execute bit
 *  only — setuid/setgid/sticky are NOT recovered from the string (it can't
 *  represent them unambiguously). The raw mode (`ExplorerEntry.permissions`) is
 *  the source of truth for special bits; this round-trip is intentionally lossy
 *  and always returns a value in the 0–0o777 range. */
export function permissionsStringToOctal(perms: string): number {
  // Drop a leading file-type character if present (10-char form).
  const p = perms.length >= 10 ? perms.slice(1, 10) : perms.slice(0, 9);
  let octal = 0;
  for (let i = 0; i < 9; i++) {
    octal <<= 1;
    const ch = p[i];
    if (ch && ch !== "-") octal |= 1;
  }
  return octal;
}

/** Sanitize raw octal text-input into the canonical 3-digit (max) string.
 *
 *  Keeps only octal digits, then takes the LAST three significant digits so the
 *  conventional leading-zero form pastes correctly: "0755" → "755" (not "075"),
 *  "4755" → "755" (the special-bit digit is dropped here — special bits are
 *  edited via the raw mode, not this field). "" stays "". */
export function sanitizeOctalInput(raw: string): string {
  return raw.replace(/[^0-7]/g, "").slice(-3);
}

/** Parse sanitized octal text into a 9-bit value, or `null` when empty. */
export function octalInputToValue(input: string): number | null {
  const cleaned = sanitizeOctalInput(input);
  return cleaned.length > 0 ? parseInt(cleaned, 8) & 0o777 : null;
}

/** Expand a 9-bit octal value into individual checkbox booleans. */
export function octalToPermissionBits(octal: number): PermissionBits {
  return {
    ownerR: (octal & 0o400) !== 0,
    ownerW: (octal & 0o200) !== 0,
    ownerX: (octal & 0o100) !== 0,
    groupR: (octal & 0o040) !== 0,
    groupW: (octal & 0o020) !== 0,
    groupX: (octal & 0o010) !== 0,
    otherR: (octal & 0o004) !== 0,
    otherW: (octal & 0o002) !== 0,
    otherX: (octal & 0o001) !== 0,
  };
}

/** Collapse checkbox booleans back into a 9-bit octal value. */
export function permissionBitsToOctal(bits: PermissionBits): number {
  return (
    (bits.ownerR ? 0o400 : 0) |
    (bits.ownerW ? 0o200 : 0) |
    (bits.ownerX ? 0o100 : 0) |
    (bits.groupR ? 0o040 : 0) |
    (bits.groupW ? 0o020 : 0) |
    (bits.groupX ? 0o010 : 0) |
    (bits.otherR ? 0o004 : 0) |
    (bits.otherW ? 0o002 : 0) |
    (bits.otherX ? 0o001 : 0)
  );
}

/** Render a 9-bit octal value as a 3-digit string, e.g. 493 → "755". */
export function octalToString(octal: number): string {
  return (octal & 0o777).toString(8).padStart(3, "0");
}

/** Render a 9-bit octal value as an `rwxr-xr-x` display string. */
export function octalToPermissionsString(octal: number): string {
  const flags: Array<[number, string]> = [
    [0o400, "r"], [0o200, "w"], [0o100, "x"],
    [0o040, "r"], [0o020, "w"], [0o010, "x"],
    [0o004, "r"], [0o002, "w"], [0o001, "x"],
  ];
  return flags.map(([bit, ch]) => ((octal & bit) !== 0 ? ch : "-")).join("");
}
