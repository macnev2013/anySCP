import { Kbd } from "anyscp";
import { Surface } from "./_fixtures";

export const SingleKey = () => <Surface><Kbd>Esc</Kbd></Surface>;

export const Shortcut = () => (
  <Surface><span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
    <Kbd>⌘</Kbd>
    <Kbd>K</Kbd>
  </span></Surface>
);

export const InlineHint = () => (
  <Surface width={520}><p className="text-[length:var(--text-sm)] text-text-secondary">
    Press <Kbd>⌘</Kbd> <Kbd>Shift</Kbd> <Kbd>P</Kbd> to open the snippet palette, or <Kbd>Esc</Kbd> to close.
  </p></Surface>
);
