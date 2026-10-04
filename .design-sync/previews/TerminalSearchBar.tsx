import { TerminalSearchBar, useSessionStore, useTerminalSearchStore } from "anyscp";

// Queries / results are per session in the search store; the case and regex
// toggles are global, so every cell shows the same toggle state.
useSessionStore.setState({ activeSessionId: null });
const RESULTS = () => new Map([
  ["s-hits", { index: 3, count: 12 }],
  ["s-miss", { index: 0, count: 0 }],
  ["s-regex", { index: 1, count: 4 }],
]);
useTerminalSearchStore.setState({
  openSessions: new Set(["s-empty", "s-hits", "s-miss", "s-regex"]),
  focusedSessionId: null,
  queries: new Map([
    ["s-hits", "error"],
    ["s-miss", "OOMKilled"],
    ["s-regex", "5\\d\\d"],
  ]),
  results: RESULTS(),
  caseSensitive: false,
  regex: true,
});

const Pane = ({ id }: { id: string }) => (
  <div className="relative bg-bg-base border border-border/60 rounded-lg font-sans" style={{ width: 480, height: 64 }}>
    <TerminalSearchBar sessionId={id} />
  </div>
);

export const Empty = () => <Pane id="s-empty" />;
export const WithMatches = () => <Pane id="s-hits" />;
export const NoResults = () => <Pane id="s-miss" />;
export const RegexQuery = () => <Pane id="s-regex" />;

// On mount the bar re-runs the query against the session's xterm search addon;
// with no live terminal it reports 0 matches and clears the seeded counts, so
// restore them once the cells have mounted (what a live buffer would report).
setTimeout(() => useTerminalSearchStore.setState({ results: RESULTS() }), 250);
