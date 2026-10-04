# design-sync notes — anySCP

anySCP is a Tauri desktop **app**, not a published component library. The "design system" is
every component under `src/components/` plus the Tailwind v4 theme in `src/theme.css`.

## Build
- `buildCmd` = `./.design-sync/build.sh`. It (1) compiles `.design-sync/tailwind.css` with Vite +
  `@tailwindcss/vite` into `dist/ds/anyscp.css` (theme tokens + every utility used in `src/` + a
  safelist of the token utility families so designs can use the vocabulary for layout glue), rewriting
  `/fonts/…` public URLs to `public/fonts/`; (2) emits `.d.ts` for `.design-sync/ds-entry.ts` into
  `dist/types/` via `.design-sync/tsconfig.dts.json`.
- Converter entry is `--entry ./.design-sync/ds-entry.ts` (synth-free: a repo-owned barrel of all
  component files + the zustand stores + `mockTauri`). New component files must be added to it.
- `package.json` carries `publishConfig.types = dist/types/index.d.ts` purely so the converter's
  `.d.ts` discovery finds the barrel (the app is private and never published).
- Converter command:
  `node .ds-sync/package-build.mjs --config .design-sync/config.json --node-modules ./node_modules --entry ./.design-sync/ds-entry.ts --out ./ds-bundle`
- Keep the safelist in `tailwind.css` small: brace-expanding every color × variant × opacity
  produced 2.1 MB of CSS once; the current set is ~110 KB.

## Runtime / previews
- `.design-sync/tauri-mock.ts` installs a fake `window.__TAURI_INTERNALS__` when absent: `list_*`
  commands resolve `[]`, `load_all_settings` `{}`, everything else `null`. It's exported first from
  the barrel so it's installed before any component module runs. Override per command with
  `mockTauri({ cmd: value | (args) => value })` (exported on `window.AnySCP`).
- Components read global zustand stores (`useHostsStore`, `useSessionStore`, …, all exported).
  Previews seed them with `useXStore.setState({...})` at module top. Every cell in a card shares
  the same store, so per-cell state variation is only possible for components driven by props.
- `.design-sync/previews/_fixtures.tsx` holds shared fixture data (`HOSTS`, `host()`), `noop`, and
  `Surface` (the `bg-bg-base` dark backdrop small components need — the preview page is white).
  It is NOT part of any grade key: edits there don't invalidate grades — re-capture by hand.
- `lucide-react` is merged into `window.AnySCP` (`extraEntries`) so designs have the app's icon set
  (+1.2 MB bundle). Lucide's `Sidebar` and `Terminal` icons collide with the components of the same
  name; the components win — use `SidebarIcon` / `TerminalIcon`. `storyImports.bundle` makes previews
  importing from `lucide-react` get real lucide.
- Overlays (`*Dialog|*Modal|*Popup|*Popover|*Palette|*Overlay|*QuickPanel`) are `cardMode: single`
  960x680; full pages `cardMode: single` 1280x800 (see `overrides`).
- Group assignment: `CardActionStrip`, `Sidebar`, `Terminal`, `TerminalPane` sit in files whose dir
  name equals the component (or a sibling file), so the converter put them in `general`; `docsMap`
  points them at category-only stubs in `.design-sync/groups/`.

## Preview authoring (learned in the first sync's fan-out)
- **Single-mode cells are inset 24px**: a 960x680 overlay card shows ~936x656, a 1280x800 page card
  ~1256x776. Pages use a `1232x752` wrapper; dialogs a `912x632` `bg-bg-base` stage.
- **Overlays need a sized stage.** `ModalShell`/`ModalBackdrop` render `fixed inset-0`; the cell root
  sizes to content, so without a sized wrapper the backdrop collapses to a ~54px strip and the dialog
  clips. Wrap in `<div className="bg-bg-base" style={{ width: 912, height: 632, transform: "translateZ(0)" }}>`
  (the transform makes the stage the containing block for `fixed` children — also how multi-cell cards
  hold several overlays).
- Utilities that appear nowhere in `src/` and aren't safelisted don't exist in `anyscp.css`; use inline
  styles for preview-only glue (or extend the safelist in `.design-sync/tailwind.css`).
- Terminal output: `emitTauriEvent("ssh:output", { session_id, data: bytes[] })` (exported) streams into
  xterm; `_fixtures.tsx` has `SHELL` canned ANSI sessions + `<ShellReplay outputs={{ [sessionId]: text }} />`.
  Terminal search runs on mount, before the replay, so search bars inside panes read "No results".
- Capture freezes the clock (~2024-05-15): relative timestamps and `{{DATE}}` render as 2024 dates.
- Hover-only UI (CardActionButton tooltip) is pinned visible with a scoped `<style>` in the preview.
- `SettingsPage` can only show its default (Appearance) section — the selected section is internal state.
- Store-driven components show one state per card (all cells share the singleton store).
- Excluded (render `null`, superseded): `NewHostPopup`, `QuickConnect`, `SidebarHeader`,
  `QuickConnectInline` — `componentSrcMap: null`. They're still in the barrel/bundle.

## Known render warns
- `[FONT_MISSING] "Fira Code"` — only a fallback in the `--font-mono` stack after JetBrains Mono
  (which ships). Suppressed via `runtimeFontPrefixes`.
- `[EXPORT_COLLISION] lucide-react … Sidebar, Terminal` — expected, see above.
- esbuild `import.meta is not available` warnings from `src/stores/terminal-instances.ts` HMR guard —
  harmless in the IIFE.

## Re-sync risks (watch-list for the next run)
- **The barrel is hand-maintained.** `.design-sync/ds-entry.ts` lists component files and stores explicitly.
  New or renamed files under `src/components/` or `src/stores/` won't sync until they're added there
  (regenerate it with the loop used originally: one `export *` per `src/components/**/*.tsx` that isn't
  a test, plus `src/stores/*-store.ts`).
- **Mock coverage is static.** `tauri-mock.ts` answers commands generically. Previews mock specific
  commands (`list_hosts`, `get_host`, `s3_list_objects`, `import_parse_ssh_config`, …). Renamed backend
  commands make those previews render empty without failing anything — eyeball the contact sheets.
- **Fixtures are outside the grade key.** Editing `previews/_fixtures.tsx` (HOSTS, SHELL, Surface,
  ShellReplay) doesn't re-grade dependants; re-capture HostCard, Kbd, StatusBar and the terminal previews by hand.
- **The Tailwind safelist only covers today's tokens.** A token added to `src/theme.css` also needs adding
  to the `@source inline(...)` lines in `.design-sync/tailwind.css`, or designs can't use its utility.
- **Previews mirror internal state.** Store seeds mirror current store shapes; a store refactor breaks
  previews at runtime (error cells), not at build time.
- **Toolchain:** Vite 7 + `@tailwindcss/vite` 4.2. Playwright 1.56.1 is installed in `.ds-sync/` to match
  the cached chromium-1194 at `/opt/pw-browsers`.
- **First-sync upload state:** the first run could not upload — Claude Design authorization wasn't
  available in that session, and there's no `projectId` in config yet. The next run with access
  creates the project (first-sync path) and uploads the verified build.
