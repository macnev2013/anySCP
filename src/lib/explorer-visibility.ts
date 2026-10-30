/** Dot-prefixed names are hidden regardless of provider or parent path. */
export function isHiddenEntry(entry: { name: string }): boolean {
  return entry.name.startsWith(".");
}

/** Keep the provider's complete listing intact for transfers and conflicts. */
export function filterExplorerEntries<T extends { name: string }>(entries: T[], showHiddenFiles: boolean): {
  visibleEntries: T[];
  hiddenCount: number;
} {
  if (showHiddenFiles) return { visibleEntries: entries, hiddenCount: 0 };
  const visibleEntries = entries.filter((entry) => !isHiddenEntry(entry));
  return { visibleEntries, hiddenCount: entries.length - visibleEntries.length };
}
