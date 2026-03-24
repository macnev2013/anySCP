import type { SearchAddon } from "@xterm/addon-search";

/** Module-level registry mapping sessionId → SearchAddon instance.
 *  Populated by Terminal.tsx on mount, consumed by TerminalSearchBar. */
const searchAddons = new Map<string, SearchAddon>();

export function registerSearchAddon(sessionId: string, addon: SearchAddon): void {
  searchAddons.set(sessionId, addon);
}

export function unregisterSearchAddon(sessionId: string): void {
  searchAddons.delete(sessionId);
}

export function getSearchAddon(sessionId: string): SearchAddon | undefined {
  return searchAddons.get(sessionId);
}
