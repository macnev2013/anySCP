import { CustomSelect } from "anyscp";
import { useEffect, useRef, useState } from "react";
import { Surface } from "./_fixtures";

const HOST_OPTIONS = [
  { value: "", label: "All Hosts" },
  { value: "h-api", label: "api-prod-01" },
  { value: "h-web", label: "web-staging" },
  { value: "h-bastion", label: "bastion" },
  { value: "h-db", label: "db-replica" },
  { value: "h-pi", label: "homelab-pi" },
];
const CURSOR_OPTIONS = [
  { value: "block", label: "Block" },
  { value: "underline", label: "Underline" },
  { value: "bar", label: "Bar" },
];
const FONT_OPTIONS = [
  { value: "'JetBrains Mono', monospace", label: "JetBrains Mono" },
  { value: "'Geist Mono', monospace", label: "Geist Mono" },
  { value: "Menlo, monospace", label: "Menlo" },
  { value: "'Courier New', monospace", label: "Courier New" },
];

const Labeled = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="flex flex-col gap-1.5">
    <span className="text-[length:var(--text-xs)] font-medium text-text-secondary">{label}</span>
    {children}
  </label>
);

function Controlled({ initial, ...rest }: { initial: string } & Omit<React.ComponentProps<typeof CustomSelect>, "value" | "onChange">) {
  const [v, setV] = useState(initial);
  return <CustomSelect value={v} onChange={setV} {...rest} />;
}

export const HostFilter = () => (
  <Surface width={300}>
    <Labeled label="Filter by host"><Controlled initial="h-api" options={HOST_OPTIONS} aria-label="Filter by host" /></Labeled>
  </Surface>
);

export const Placeholder = () => (
  <Surface width={300}>
    <Labeled label="Jump host"><Controlled initial="none" options={HOST_OPTIONS.slice(1)} placeholder="Select a jump host…" /></Labeled>
  </Surface>
);

export const Disabled = () => (
  <Surface width={300}>
    <Labeled label="Cursor style"><Controlled initial="block" options={CURSOR_OPTIONS} disabled /></Labeled>
  </Surface>
);

// Opens itself on mount so the portaled listbox is visible in the capture.
export const OpenFontPicker = () => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => ref.current?.querySelector<HTMLButtonElement>("button[role=combobox]")?.click(), 50);
    return () => clearTimeout(t);
  }, []);
  return (
    <div ref={ref}>
      <Surface width={300} pad={16}>
        <div style={{ height: 210 }}>
          <Labeled label="Terminal font"><Controlled initial="'JetBrains Mono', monospace" options={FONT_OPTIONS} previewOptionFont /></Labeled>
        </div>
      </Surface>
    </div>
  );
};
