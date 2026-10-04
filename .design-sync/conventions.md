# anySCP — conventions for building with this library

anySCP is a dark-first desktop SSH / SFTP / S3 client. These are its real React components. They were written for a Tauri shell, and the bundle includes a browser stand-in for that backend, so they render in a plain page.

## Setup and wrapping
- There is no provider component. Linking `styles.css` applies the theme: `html, body` get `bg-bg-base`, `text-text-primary`, Geist at 15px, **`height:100%` and `overflow:hidden`**. Wrap scrollable designs in your own `h-full overflow-y-auto` container.
- **Light theme:** set `data-theme="light"` on `<html>`. **Accent hue:** set the `--accent-hue` CSS variable (default 250).
- **Data comes from global zustand stores**, all on `window.AnySCP`: `useHostsStore`, `useGroupsStore`, `useSessionStore`, `useSftpStore`, `useS3Store`, `useSnippetsStore`, `useTransferStore`, `useTabStore`, `useUiStore`, `useSettingsStore`, `useHealthStore`, `usePortForwardStore`, `useToastStore`, `useUpdaterStore`, `useTerminalSearchStore`. Seed them once before rendering: `useHostsStore.setState({ hosts: [...] })`.
- **Backend calls:** every backend call goes through a mock. `list_*` returns `[]`, everything else returns `null`. Components that load data on mount (dashboards and pages) overwrite your seeded store with those empty results, so mock the command instead: `mockTauri({ list_hosts: hosts, list_groups: groups })`.
- **Terminal output:** stream it into a `Terminal`/`TerminalPane` with `emitTauriEvent("ssh:output", { session_id, data: [...new TextEncoder().encode(text)] })`. ANSI colours work.
- **Icons:** every lucide-react icon is also on `window.AnySCP` (`FolderOpen`, `TerminalSquare`, `Server`, …). The icons `Terminal` and `Sidebar` are shadowed by the components of the same name; use `TerminalIcon` / `SidebarIcon` instead. The app draws icons at `size={14–16}` with `strokeWidth={1.8}`.

## Styling idiom
The app uses Tailwind v4 utilities named after design tokens. Prefer token utilities over raw colours.

| Family | Classes |
|---|---|
| Surfaces (dark → light) | `bg-bg-base` `bg-bg-surface` `bg-bg-overlay` `bg-bg-subtle` `bg-bg-muted` |
| Text | `text-text-primary` `text-text-secondary` `text-text-muted` `text-text-inverse` |
| Accent | `bg-accent` `hover:bg-accent-hover` `text-accent` `bg-accent/10` |
| Status | `text-status-connected` `text-status-connecting` `text-status-error` `text-status-disconnected` (also `bg-`) |
| Lines / focus | `border border-border` `border-border/60` `focus:border-border-focus` `ring-ring` |
| Type size | `text-[length:var(--text-xs)]` and the `2xs` / `sm` / `base` / `lg` steps; `font-mono` (JetBrains Mono) for hosts, paths, sizes |
| Shape / elevation | `rounded-lg` (controls), `rounded-xl` (cards), `shadow-[var(--shadow-lg)]` (menus) |

- **Buttons:** use the exported class strings `BTN_PRIMARY`, `BTN_SECONDARY`, `BTN_GHOST`, `BTN_DANGER` as `className`. Don't restyle buttons yourself.
- **Dialogs:** compose `ModalShell` (props `title`, `subtitle`, `icon`, `iconVariant`, `maxWidth`, `footer`, `scrollable`) or use `ConfirmDangerDialog` for destructive confirms.
- **Missing classes:** the stylesheet is compiled. Utilities used by the app, plus the token, spacing and layout families above, exist; arbitrary or one-off classes may not. Use inline `style` for unusual values.

## Where the truth lives
- Read `styles.css` → `_ds_bundle.css` for every token (`--color-*`, `--text-*`, `--shadow-*`, `--duration-*`) and the compiled utilities.
- Read `components/<group>/<Name>/<Name>.prompt.md` and `<Name>.d.ts` for each component's props and examples.

## Example
```jsx
const { HostCard, useHostsStore, BTN_PRIMARY } = window.AnySCP;
const hosts = [/* SavedHost objects: id, label, host, port, username, environment, os_type, last_connected_at, ... */];
useHostsStore.setState({ hosts });

<section className="h-full overflow-y-auto bg-bg-base p-6">
  <div className="flex items-center justify-between mb-4">
    <h2 className="text-[length:var(--text-lg)] font-semibold text-text-primary">Production</h2>
    <button className={BTN_PRIMARY}>New host</button>
  </div>
  <div className="grid grid-cols-3 gap-3">
    {hosts.map((h) => (
      <HostCard key={h.id} host={h} onConnect={() => {}} onExplore={() => {}}
        onEdit={() => {}} onDelete={() => {}} onDuplicate={() => {}} />
    ))}
  </div>
</section>
```
