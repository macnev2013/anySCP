// Browser stand-in for the Tauri IPC bridge. Outside the desktop shell
// `window.__TAURI_INTERNALS__` is undefined and every `invoke()` throws, so
// this installs a mock that answers `list_*` commands with [] and everything
// else with null. Previews and designs seed realistic data via
// `mockTauri({ list_hosts: [...] })` or by setting the zustand stores directly.
type Handler = unknown | ((args: Record<string, unknown>) => unknown);

const handlers: Record<string, Handler> = {};
let nextCallbackId = 1;

export function mockTauri(map: Record<string, Handler>): void {
  Object.assign(handlers, map);
}

function respond(cmd: string, args: Record<string, unknown>): unknown {
  if (cmd in handlers) {
    const h = handlers[cmd];
    return typeof h === "function" ? (h as (a: Record<string, unknown>) => unknown)(args) : h;
  }
  if (/^(plugin:[a-z-]+\|)?list_|_list_|^list/.test(cmd)) return [];
  if (cmd === "load_all_settings") return {};
  return null;
}

const w = window as unknown as { __TAURI_INTERNALS__?: Record<string, unknown> };
if (!w.__TAURI_INTERNALS__) {
  w.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => respond(cmd, args),
    transformCallback: () => nextCallbackId++,
    unregisterCallback: () => {},
    convertFileSrc: (p: string) => p,
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  };
}
