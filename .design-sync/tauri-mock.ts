// Browser stand-in for the Tauri IPC bridge. Outside the desktop shell
// `window.__TAURI_INTERNALS__` is undefined and every `invoke()` throws, so
// this installs a mock that answers `list_*` commands with [] and everything
// else with null. Previews and designs seed realistic data via
// `mockTauri({ list_hosts: [...] })` or by setting the zustand stores directly,
// and push backend events (e.g. terminal output on "ssh:output") with
// `emitTauriEvent(event, payload)`.
type Handler = unknown | ((args: Record<string, unknown>) => unknown);

const handlers: Record<string, Handler> = {};
const callbacks = new Map<number, (msg: unknown) => void>();
const listeners = new Map<string, Map<number, number>>(); // event -> (eventId -> callbackId)
let nextCallbackId = 1;
let nextEventId = 1;

export function mockTauri(map: Record<string, Handler>): void {
  Object.assign(handlers, map);
}

/** Deliver a backend event to every `listen(event, ...)` subscriber. */
export function emitTauriEvent(event: string, payload: unknown): void {
  for (const [id, cb] of listeners.get(event) ?? []) callbacks.get(cb)?.({ event, id, payload });
}

function respond(cmd: string, args: Record<string, unknown>): unknown {
  if (cmd === "plugin:event|listen") {
    const id = nextEventId++;
    const event = String(args.event);
    if (!listeners.has(event)) listeners.set(event, new Map());
    listeners.get(event)!.set(id, Number(args.handler));
    return id;
  }
  if (cmd === "plugin:event|unlisten") {
    listeners.get(String(args.event))?.delete(Number(args.eventId));
    return null;
  }
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
    transformCallback: (cb?: (msg: unknown) => void) => {
      const id = nextCallbackId++;
      if (cb) callbacks.set(id, cb);
      return id;
    },
    unregisterCallback: (id: number) => callbacks.delete(id),
    convertFileSrc: (p: string) => p,
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  };
}

const ew = window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__?: Record<string, unknown> };
if (!ew.__TAURI_EVENT_PLUGIN_INTERNALS__) {
  ew.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (event: string, eventId: number) => listeners.get(event)?.delete(eventId),
  };
}
