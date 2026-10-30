import { useCallback, useEffect, useRef, useState } from "react";
import type { ExplorerEntry } from "../types/explorer";
import { QuickLookClient, type PreviewProgress, type QuickLookTarget } from "../lib/quick-look";
import { toast } from "../stores/toast-store";

export function useQuickLook(isActive: boolean, scope: string) {
  const client = useRef<QuickLookClient | null>(null);
  const active = useRef(isActive);
  active.current = isActive;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [supported, setSupported] = useState(false);
  const [state, setState] = useState<PreviewProgress | null>(null);
  const [showProgress, setShowProgress] = useState(false);

  useEffect(() => {
    const owner = new QuickLookClient(crypto.randomUUID(), setState, toast.error);
    client.current = owner;
    void owner.connect().then((value) => { if (client.current === owner) setSupported(value); });
    return () => { owner.dispose(); if (client.current === owner) client.current = null; };
  }, []);

  // Navigation, bucket, transport, session and tab visibility invalidate the
  // owner immediately. Changing selection never automatically previews a file.
  useEffect(() => {
    if (!isActive) client.current?.close();
    return () => client.current?.close();
  }, [scope, isActive]);

  const pending = state?.phase === "preparing" || state?.phase === "downloading";
  const requestId = state?.requestId;
  useEffect(() => {
    setShowProgress(false);
    if (!pending) return;
    const timer = setTimeout(() => setShowProgress(true), 300);
    return () => clearTimeout(timer);
  }, [requestId, pending]);

  const toggle = useCallback((entry: ExplorerEntry, target: QuickLookTarget, restore: () => void) => {
    if (!active.current) return;
    const openedIn = currentScope.current;
    client.current?.toggle(entry, target, () => {
      requestAnimationFrame(() => { if (active.current && currentScope.current === openedIn && document.hasFocus()) restore(); });
    });
  }, []);
  const invalidate = useCallback(() => client.current?.close(false), []);
  const close = useCallback(() => client.current?.close(true), []);
  const selectionChanged = useCallback((entries: ExplorerEntry[]) => client.current?.selectionChanged(entries), []);

  return { supported: supported && isActive, toggle, close, invalidate, selectionChanged, hasPreview: state !== null,
    pending: !!pending, progress: showProgress && pending ? state : null };
}
