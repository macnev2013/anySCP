import { create } from "zustand";

interface SearchResults {
  index: number;
  count: number;
}

interface TerminalSearchState {
  /** Sessions that currently have search bar open */
  openSessions: Set<string>;
  /** Which session's search bar has input focus */
  focusedSessionId: string | null;
  /** Query per session */
  queries: Map<string, string>;
  /** Match results per session */
  results: Map<string, SearchResults>;
  /** Global toggles (shared across all panes) */
  caseSensitive: boolean;
  regex: boolean;

  openSearch: (sessionId: string) => void;
  closeSearch: (sessionId: string) => void;
  setQuery: (sessionId: string, query: string) => void;
  setResults: (sessionId: string, index: number, count: number) => void;
  toggleCaseSensitive: () => void;
  toggleRegex: () => void;
}

export const useTerminalSearchStore = create<TerminalSearchState>((set) => ({
  openSessions: new Set(),
  focusedSessionId: null,
  queries: new Map(),
  results: new Map(),
  caseSensitive: false,
  regex: false,

  openSearch: (sessionId) =>
    set((state) => {
      const next = new Set(state.openSessions);
      next.add(sessionId);
      return { openSessions: next, focusedSessionId: sessionId };
    }),

  closeSearch: (sessionId) =>
    set((state) => {
      const openSessions = new Set(state.openSessions);
      openSessions.delete(sessionId);
      const queries = new Map(state.queries);
      queries.delete(sessionId);
      const results = new Map(state.results);
      results.delete(sessionId);
      return {
        openSessions,
        queries,
        results,
        focusedSessionId: state.focusedSessionId === sessionId ? null : state.focusedSessionId,
      };
    }),

  setQuery: (sessionId, query) =>
    set((state) => {
      const queries = new Map(state.queries);
      queries.set(sessionId, query);
      return { queries };
    }),

  setResults: (sessionId, index, count) =>
    set((state) => {
      const results = new Map(state.results);
      results.set(sessionId, { index, count });
      return { results };
    }),

  toggleCaseSensitive: () =>
    set((state) => ({ caseSensitive: !state.caseSensitive })),

  toggleRegex: () =>
    set((state) => ({ regex: !state.regex })),
}));
