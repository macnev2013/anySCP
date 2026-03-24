interface KbdProps {
  children: string;
}

export function Kbd({ children }: KbdProps) {
  return (
    <kbd className="inline-flex items-center px-1.5 py-0.5 text-[length:var(--text-xs)] font-mono font-medium bg-bg-subtle text-text-secondary rounded border border-border">
      {children}
    </kbd>
  );
}
