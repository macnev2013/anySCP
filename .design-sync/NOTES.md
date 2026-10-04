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

## Known render warns
- `[FONT_MISSING] "Fira Code"` — only a fallback in the `--font-mono` stack after JetBrains Mono
  (which ships). Suppressed via `runtimeFontPrefixes`.
- `[EXPORT_COLLISION] lucide-react … Sidebar, Terminal` — expected, see above.
- esbuild `import.meta is not available` warnings from `src/stores/terminal-instances.ts` HMR guard —
  harmless in the IIFE.
