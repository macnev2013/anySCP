import { useCallback, useEffect, useRef } from "react";
import { useRdpStatus } from "../../hooks/use-rdp-events";
import { useRdpStore } from "../../stores/rdp-store";
import type { RdpSessionId } from "../../types";

// ─── Scancode map (DOM code → PS/2) ────────────────────────────────────────

const SC: Record<string, [number, boolean]> = {
  Escape:[0x01,false],Digit1:[0x02,false],Digit2:[0x03,false],Digit3:[0x04,false],
  Digit4:[0x05,false],Digit5:[0x06,false],Digit6:[0x07,false],Digit7:[0x08,false],
  Digit8:[0x09,false],Digit9:[0x0a,false],Digit0:[0x0b,false],Minus:[0x0c,false],
  Equal:[0x0d,false],Backspace:[0x0e,false],Tab:[0x0f,false],KeyQ:[0x10,false],
  KeyW:[0x11,false],KeyE:[0x12,false],KeyR:[0x13,false],KeyT:[0x14,false],
  KeyY:[0x15,false],KeyU:[0x16,false],KeyI:[0x17,false],KeyO:[0x18,false],
  KeyP:[0x19,false],BracketLeft:[0x1a,false],BracketRight:[0x1b,false],
  Enter:[0x1c,false],ControlLeft:[0x1d,false],KeyA:[0x1e,false],KeyS:[0x1f,false],
  KeyD:[0x20,false],KeyF:[0x21,false],KeyG:[0x22,false],KeyH:[0x23,false],
  KeyJ:[0x24,false],KeyK:[0x25,false],KeyL:[0x26,false],Semicolon:[0x27,false],
  Quote:[0x28,false],Backquote:[0x29,false],ShiftLeft:[0x2a,false],
  Backslash:[0x2b,false],KeyZ:[0x2c,false],KeyX:[0x2d,false],KeyC:[0x2e,false],
  KeyV:[0x2f,false],KeyB:[0x30,false],KeyN:[0x31,false],KeyM:[0x32,false],
  Comma:[0x33,false],Period:[0x34,false],Slash:[0x35,false],ShiftRight:[0x36,false],
  NumpadMultiply:[0x37,false],AltLeft:[0x38,false],Space:[0x39,false],
  CapsLock:[0x3a,false],F1:[0x3b,false],F2:[0x3c,false],F3:[0x3d,false],
  F4:[0x3e,false],F5:[0x3f,false],F6:[0x40,false],F7:[0x41,false],
  F8:[0x42,false],F9:[0x43,false],F10:[0x44,false],NumLock:[0x45,false],
  ScrollLock:[0x46,false],Numpad7:[0x47,false],Numpad8:[0x48,false],
  Numpad9:[0x49,false],NumpadSubtract:[0x4a,false],Numpad4:[0x4b,false],
  Numpad5:[0x4c,false],Numpad6:[0x4d,false],NumpadAdd:[0x4e,false],
  Numpad1:[0x4f,false],Numpad2:[0x50,false],Numpad3:[0x51,false],
  Numpad0:[0x52,false],NumpadDecimal:[0x53,false],F11:[0x57,false],F12:[0x58,false],
  NumpadEnter:[0x1c,true],ControlRight:[0x1d,true],NumpadDivide:[0x35,true],
  PrintScreen:[0x37,true],AltRight:[0x38,true],Home:[0x47,true],ArrowUp:[0x48,true],
  PageUp:[0x49,true],ArrowLeft:[0x4b,true],ArrowRight:[0x4d,true],End:[0x4f,true],
  ArrowDown:[0x50,true],PageDown:[0x51,true],Insert:[0x52,true],Delete:[0x53,true],
  MetaLeft:[0x5b,true],MetaRight:[0x5c,true],ContextMenu:[0x5d,true],
};

const BTN: Record<number, string> = { 0: "left", 1: "middle", 2: "right" };

// ─── Component ──────────────────────────────────────────────────────────────

interface RdpViewerProps {
  sessionId: RdpSessionId;
}

export function RdpViewer({ sessionId }: RdpViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const updateStatus = useRdpStore((s) => s.updateStatus);
  const session = useRdpStore((s) => s.sessions.get(sessionId));
  const configWidth = session?.config.width ?? 1920;
  const configHeight = session?.config.height ?? 1080;
  const wsPort = session?.wsPort ?? 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !wsPort) return;

    const visibleCtx = canvas.getContext("2d");
    if (!visibleCtx) return;

    // Offscreen back-buffer for double-buffering
    const offscreen = document.createElement("canvas");
    offscreen.width = configWidth;
    offscreen.height = configHeight;
    const offCtx = offscreen.getContext("2d")!;

    let disposed = false;
    let ws: WebSocket | null = null;
    let dirty = false;
    let rafId = 0;

    // Perf counters
    let wsMessages = 0;
    let paintCount = 0;
    const fpsInterval = setInterval(() => {
      if (wsMessages > 0 || paintCount > 0) {
        console.log(`[RDP] WS: ${(wsMessages / 2).toFixed(0)}/s | Paint: ${(paintCount / 2).toFixed(0)}/s`);
      }
      wsMessages = 0;
      paintCount = 0;
    }, 2000);

    // rAF loop — blit offscreen → visible when dirty
    const render = () => {
      if (disposed) return;
      if (dirty) {
        visibleCtx.drawImage(offscreen, 0, 0);
        dirty = false;
        paintCount++;
      }
      rafId = requestAnimationFrame(render);
    };
    rafId = requestAnimationFrame(render);

    const connect = () => {
      if (disposed) return;
      ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onmessage = (event: MessageEvent) => {
        const buf = event.data as ArrayBuffer;
        if (buf.byteLength < 8) return;

        const hdr = new DataView(buf, 0, 8);
        const x = hdr.getUint16(0, true);
        const y = hdr.getUint16(2, true);
        const w = hdr.getUint16(4, true);
        const h = hdr.getUint16(6, true);

        const pixelBytes = w * h * 4;
        if (buf.byteLength < 8 + pixelBytes) return;

        const pixels = new Uint8ClampedArray(buf, 8, pixelBytes);
        offCtx.putImageData(new ImageData(pixels, w, h), x, y);
        dirty = true;
        wsMessages++;
      };

      ws.onerror = () => { if (!disposed) setTimeout(connect, 500); };
      ws.onclose = () => { if (!disposed) setTimeout(connect, 500); };
    };

    const timer = setTimeout(connect, 100);

    return () => {
      disposed = true;
      clearTimeout(timer);
      clearInterval(fpsInterval);
      cancelAnimationFrame(rafId);
      ws?.close();
      wsRef.current = null;
    };
  }, [sessionId, wsPort, configWidth, configHeight]);

  useRdpStatus(sessionId, (p) => updateStatus(p.session_id, p.status, p.message));

  const sendKey = useCallback(
    (code: string, pressed: boolean) => {
      const m = SC[code];
      if (!m) return;
      (async () => {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("rdp_send_key", { sessionId, input: { scancode: m[0], extended: m[1], pressed } });
      })();
    },
    [sessionId],
  );

  const coords = useCallback(
    (e: React.MouseEvent) => {
      const c = canvasRef.current;
      if (!c) return { x: 0, y: 0 };
      const r = c.getBoundingClientRect();
      return {
        x: Math.round((e.clientX - r.left) * (configWidth / r.width)),
        y: Math.round((e.clientY - r.top) * (configHeight / r.height)),
      };
    },
    [configWidth, configHeight],
  );

  const sendMouse = useCallback(
    (e: React.MouseEvent, button?: string, pressed?: boolean) => {
      const { x, y } = coords(e);
      (async () => {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("rdp_send_mouse", {
          sessionId,
          input: { x, y, button: button ?? null, pressed: pressed ?? false, wheel_delta: null },
        });
      })();
    },
    [sessionId, coords],
  );

  return (
    <div className="flex h-full w-full items-center justify-center bg-bg-base">
      <canvas
        ref={canvasRef}
        width={configWidth}
        height={configHeight}
        tabIndex={0}
        className="max-h-full max-w-full outline-none"
        style={{ objectFit: "contain" }}
        onKeyDown={(e) => { e.preventDefault(); e.stopPropagation(); sendKey(e.code, true); }}
        onKeyUp={(e) => { e.preventDefault(); e.stopPropagation(); sendKey(e.code, false); }}
        onMouseMove={(e) => sendMouse(e)}
        onMouseDown={(e) => { canvasRef.current?.focus(); sendMouse(e, BTN[e.button], true); }}
        onMouseUp={(e) => sendMouse(e, BTN[e.button], false)}
        onWheel={(e) => {
          const { x, y } = coords(e);
          (async () => {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("rdp_send_mouse", {
              sessionId, input: { x, y, button: null, pressed: false, wheel_delta: e.deltaY > 0 ? -120 : 120 },
            });
          })();
        }}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  );
}
