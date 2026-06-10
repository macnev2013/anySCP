// Helpers for the drag-drop upload overwrite pre-check.

/** Basename of a local path, handling both POSIX and Windows separators. */
export function basename(localPath: string): string {
  return localPath.split(/[/\\]/).pop() || localPath;
}

/**
 * Basenames of dropped local paths that already exist in the target directory,
 * de-duplicated. Two dropped files that share a basename collapse to a single
 * conflict entry (they would otherwise inflate the count and produce duplicate
 * React keys in the confirmation list, and only the last would survive the
 * upload anyway).
 */
export function conflictingNames(localPaths: string[], existingNames: Set<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of localPaths) {
    const name = basename(p);
    if (existingNames.has(name) && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}
