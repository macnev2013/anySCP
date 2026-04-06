import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check } from "lucide-react";

export interface SelectOption {
  value: string;
  label: string;
}

interface CustomSelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  "aria-label"?: string;
}

export function CustomSelect({
  value,
  options,
  onChange,
  placeholder = "Select...",
  disabled,
  className,
  id,
  "aria-label": ariaLabel,
}: CustomSelectProps) {
  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((o) => o.value === value);
  const displayLabel = selectedOption?.label ?? placeholder;

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        containerRef.current && !containerRef.current.contains(target) &&
        listRef.current && !listRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [open]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (!open || highlightIndex < 0 || !listRef.current) return;
    const item = listRef.current.children[highlightIndex] as HTMLElement;
    item?.scrollIntoView({ block: "nearest" });
  }, [open, highlightIndex]);

  const computePos = () => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setDropdownPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;

    if (!open && (e.key === "Enter" || e.key === " " || e.key === "ArrowDown")) {
      e.preventDefault();
      computePos();
      setOpen(true);
      setHighlightIndex(options.findIndex((o) => o.value === value));
      return;
    }

    if (!open) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((prev) => Math.min(prev + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (highlightIndex >= 0 && highlightIndex < options.length) {
        onChange(options[highlightIndex].value);
        setOpen(false);
      }
    }
  };

  return (
    <div ref={containerRef} className={`relative ${className ?? ""}`}>
      {/* Trigger */}
      <button
        ref={triggerRef}
        type="button"
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => {
          if (!disabled) {
            if (!open) computePos();
            setOpen(!open);
            if (!open) setHighlightIndex(options.findIndex((o) => o.value === value));
          }
        }}
        onKeyDown={handleKeyDown}
        className={[
          "w-full flex items-center justify-between gap-2",
          "rounded-lg bg-bg-base border border-border px-3 py-2",
          "text-[length:var(--text-sm)] text-left",
          "outline-none transition-[border-color,box-shadow] duration-[var(--duration-fast)]",
          "focus:border-border-focus focus:ring-2 focus:ring-ring",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          open ? "border-border-focus ring-2 ring-ring" : "",
        ].join(" ")}
      >
        <span className={selectedOption ? "text-text-primary truncate" : "text-text-muted truncate"}>
          {displayLabel}
        </span>
        <ChevronDown
          size={14}
          strokeWidth={2}
          className={[
            "text-text-muted shrink-0 transition-transform duration-[var(--duration-fast)]",
            open ? "rotate-180" : "",
          ].join(" ")}
          aria-hidden="true"
        />
      </button>

      {/* Dropdown — portaled to body to escape transform/overflow ancestors */}
      {open && dropdownPos && createPortal(
        <div
          ref={listRef}
          role="listbox"
          aria-label={ariaLabel}
          style={{ top: dropdownPos.top, left: dropdownPos.left, width: dropdownPos.width }}
          className={[
            "fixed z-[100]",
            "max-h-[200px] overflow-y-auto",
            "bg-bg-overlay border border-border rounded-lg",
            "shadow-[var(--shadow-lg)]",
            "py-1",
            "animate-[fadeIn_80ms_var(--ease-expo-out)_both]",
          ].join(" ")}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            const isHighlighted = index === highlightIndex;

            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                onMouseEnter={() => setHighlightIndex(index)}
                className={[
                  "w-full flex items-center gap-2 px-3 py-1.5 text-left",
                  "text-[length:var(--text-sm)] transition-colors duration-[var(--duration-fast)]",
                  isHighlighted ? "bg-bg-subtle" : "",
                  isSelected ? "text-accent font-medium" : "text-text-primary",
                ].join(" ")}
              >
                <span className="w-4 shrink-0">
                  {isSelected && <Check size={13} strokeWidth={2.5} className="text-accent" />}
                </span>
                <span className="truncate">{option.label}</span>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
