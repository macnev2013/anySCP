import { useState, useEffect, useCallback } from "react";
import { useSettingsStore } from "../../stores/settings-store";
import { RefreshCw, CheckCircle2, AlertCircle, Download, Palette, SquareTerminal, ArrowUpDown, Info, ExternalLink } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { CursorStyle, ThemeMode } from "../../stores/settings-store";

// ─── Shared styles ───────────────────────────────────────────────────────────

const LABEL_CLASS = "text-[length:var(--text-sm)] font-medium text-text-primary";
const DESC_CLASS = "text-[length:var(--text-xs)] text-text-muted mt-0.5";

const INPUT_CLASS = [
  "w-20 px-2.5 py-1.5 rounded-lg text-[length:var(--text-sm)] tabular-nums",
  "bg-bg-base border border-border text-text-primary",
  "outline-none focus:border-border-focus focus:ring-2 focus:ring-ring",
  "transition-[border-color,box-shadow] duration-[var(--duration-fast)]",
].join(" ");

const REPO_URL = "https://github.com/macnev2013/anySCP";

// ─── Sections ─────────────────────────────────────────────────────────────────
// Each settings category is a section here. To add a new category, add an entry
// to SECTIONS, a description, and render its content in <SectionContent />.

type SectionId = "appearance" | "terminal" | "transfers" | "about";

const SECTIONS: { id: SectionId; label: string; icon: LucideIcon }[] = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "transfers", label: "Transfers", icon: ArrowUpDown },
  { id: "about", label: "About & Updates", icon: Info },
];

const SECTION_DESCRIPTIONS: Record<SectionId, string> = {
  appearance: "Theme and interface look.",
  terminal: "Font, cursor, and scrollback history.",
  transfers: "Control how files are transferred.",
  about: "App information, links, and updates.",
};

// ─── Component ───────────────────────────────────────────────────────────────

export function SettingsPage() {
  const [active, setActive] = useState<SectionId>("appearance");
  const activeSection = SECTIONS.find((s) => s.id === active);

  return (
    <div className="flex flex-col h-full p-2">
      <div className="flex flex-1 min-h-0 rounded-lg overflow-hidden border border-border/60">
        {/* Sidebar */}
        <nav
          aria-label="Settings sections"
          className="w-60 shrink-0 flex flex-col gap-1 px-3 py-4 border-r border-border/50 bg-bg-surface/40 overflow-y-auto no-select"
        >
          <h2 className="px-3 pt-1 pb-2 text-[length:var(--text-2xs)] font-semibold uppercase tracking-wider text-text-muted">
            Settings
          </h2>
          {SECTIONS.map(({ id, label, icon: Icon }) => {
            const isActive = active === id;
            return (
              <button
                key={id}
                type="button"
                data-testid={`settings-nav-${id}`}
                aria-current={isActive ? "page" : undefined}
                onClick={() => setActive(id)}
                className={[
                  "flex items-center gap-2.5 px-3 py-2 rounded-lg text-left",
                  "text-[length:var(--text-sm)] font-medium",
                  "transition-colors duration-[var(--duration-fast)]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isActive
                    ? "bg-bg-overlay text-text-primary border border-border/60 shadow-[var(--shadow-sm)]"
                    : "text-text-secondary border border-transparent hover:text-text-primary hover:bg-bg-overlay/50",
                ].join(" ")}
              >
                <Icon
                  size={17}
                  strokeWidth={isActive ? 2 : 1.6}
                  className={`shrink-0 ${isActive ? "text-accent" : "text-text-muted"}`}
                />
                {label}
              </button>
            );
          })}
        </nav>

        {/* Content */}
        <div className="flex-1 overflow-y-auto bg-bg-base">
          <div className="max-w-4xl mx-auto px-8 py-6">
            {/* Section header */}
            <div className="mb-6">
              <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
                {activeSection?.label}
              </h1>
              <p className="text-[length:var(--text-sm)] text-text-muted mt-1.5">
                {SECTION_DESCRIPTIONS[active]}
              </p>
            </div>

            <SectionContent section={active} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Section content ───────────────────────────────────────────────────────────

function SectionContent({ section }: { section: SectionId }) {
  switch (section) {
    case "appearance":
      return <AppearanceSettings />;
    case "terminal":
      return <TerminalSettings />;
    case "transfers":
      return <TransferSettings />;
    case "about":
      return <AboutSettings />;
  }
}

function AppearanceSettings() {
  const themeMode = useSettingsStore((s) => s.themeMode);
  const setThemeMode = useSettingsStore((s) => s.setThemeMode);

  return (
    <SettingsGroup label="Theme">
      <SettingRow>
        <div>
          <p className={LABEL_CLASS}>Color Theme</p>
          <p className={DESC_CLASS}>Switch between the dark and softer grey light interface</p>
        </div>
        <SegmentedControl<ThemeMode>
          id="s-light-theme"
          value={themeMode}
          onChange={setThemeMode}
          options={[
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
          ]}
        />
      </SettingRow>
    </SettingsGroup>
  );
}

function TerminalSettings() {
  const fontSize = useSettingsStore((s) => s.terminalFontSize);
  const cursorStyle = useSettingsStore((s) => s.terminalCursorStyle);
  const cursorBlink = useSettingsStore((s) => s.terminalCursorBlink);
  const lineHeight = useSettingsStore((s) => s.terminalLineHeight);
  const scrollback = useSettingsStore((s) => s.terminalScrollback);

  const setFontSize = useSettingsStore((s) => s.setTerminalFontSize);
  const setCursorStyle = useSettingsStore((s) => s.setTerminalCursorStyle);
  const setCursorBlink = useSettingsStore((s) => s.setTerminalCursorBlink);
  const setLineHeight = useSettingsStore((s) => s.setTerminalLineHeight);
  const setScrollback = useSettingsStore((s) => s.setTerminalScrollback);

  return (
    <>
      <SettingsGroup label="Font">
        <SettingRow>
          <div>
            <label htmlFor="s-fontsize" className={LABEL_CLASS}>Font Size</label>
            <p className={DESC_CLASS}>Size in pixels (8–32)</p>
          </div>
          <NumberSetting id="s-fontsize" value={fontSize} min={8} max={32} step={1} onChange={setFontSize} />
        </SettingRow>

        <SettingRow>
          <div>
            <label htmlFor="s-lineheight" className={LABEL_CLASS}>Line Height</label>
            <p className={DESC_CLASS}>Spacing between lines (1.0–2.0)</p>
          </div>
          <NumberSetting id="s-lineheight" value={lineHeight} min={1.0} max={2.0} step={0.1} onChange={setLineHeight} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label="Cursor">
        <SettingRow>
          <div>
            <p className={LABEL_CLASS}>Cursor Style</p>
            <p className={DESC_CLASS}>Shape of the terminal cursor</p>
          </div>
          <SegmentedControl<CursorStyle>
            id="s-cursor"
            value={cursorStyle}
            onChange={setCursorStyle}
            options={[
              { value: "bar", label: "Bar" },
              { value: "block", label: "Block" },
              { value: "underline", label: "Underline" },
            ]}
          />
        </SettingRow>

        <SettingRow>
          <div>
            <label htmlFor="s-blink" className={LABEL_CLASS}>Cursor Blink</label>
            <p className={DESC_CLASS}>Animate the cursor</p>
          </div>
          <Toggle id="s-blink" checked={cursorBlink} onChange={setCursorBlink} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label="History">
        <SettingRow>
          <div>
            <label htmlFor="s-scrollback" className={LABEL_CLASS}>Scrollback Buffer</label>
            <p className={DESC_CLASS}>Number of lines to keep in history (500–100,000)</p>
          </div>
          <NumberSetting id="s-scrollback" value={scrollback} min={500} max={100000} step={500} onChange={setScrollback} />
        </SettingRow>
        <p className="px-1 text-[length:var(--text-xs)] text-text-muted">
          Terminal settings apply to new terminals. Existing terminals keep their current settings.
        </p>
      </SettingsGroup>
    </>
  );
}

function TransferSettings() {
  const transferConcurrency = useSettingsStore((s) => s.transferConcurrency);
  const setConcurrency = useSettingsStore((s) => s.setTransferConcurrency);

  return (
    <SettingsGroup>
      <SettingRow>
        <div>
          <label htmlFor="s-concurrency" className={LABEL_CLASS}>Concurrent Transfers</label>
          <p className={DESC_CLASS}>Maximum simultaneous file transfers (1–10)</p>
        </div>
        <NumberSetting id="s-concurrency" value={transferConcurrency} min={1} max={10} step={1} onChange={setConcurrency} />
      </SettingRow>
    </SettingsGroup>
  );
}

function AboutSettings() {
  return (
    <>
      <SettingsGroup label="About">
        <AboutCard />
      </SettingsGroup>
      <SettingsGroup label="Updates">
        <UpdateChecker />
      </SettingsGroup>
    </>
  );
}

function AboutCard() {
  const [appVersion, setAppVersion] = useState<string | null>(null);

  // Real app version (injected from git tags at build).
  useEffect(() => {
    void (async () => {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        setAppVersion(await getVersion());
      } catch { /* best-effort */ }
    })();
  }, []);

  const openRepo = useCallback(async () => {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(REPO_URL);
    } catch { /* best-effort */ }
  }, []);

  return (
    <div className="px-4 py-3 rounded-xl bg-bg-surface border border-border/50">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-[length:var(--text-base)] font-semibold text-text-primary">anySCP</p>
          <p className={DESC_CLASS}>A modern desktop client for SSH, SFTP, and S3</p>
        </div>
        <span className="shrink-0 text-[length:var(--text-xs)] tabular-nums text-text-muted">
          {appVersion ? `v${appVersion}` : ""}
        </span>
      </div>

      <div className="mt-3 pt-3 border-t border-border/50 flex items-center justify-between gap-4">
        <div>
          <p className={LABEL_CLASS}>Repository</p>
          <p className={DESC_CLASS}>Source code, issues, and releases on GitHub</p>
        </div>
        <button
          onClick={() => void openRepo()}
          className={[
            "flex items-center gap-1.5 px-3 py-1.5 rounded-lg shrink-0",
            "text-[length:var(--text-sm)] font-medium",
            "bg-bg-base border border-border text-text-secondary",
            "hover:text-text-primary hover:border-border-focus",
            "transition-all duration-[var(--duration-fast)]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          ].join(" ")}
        >
          <ExternalLink size={13} strokeWidth={2} />
          GitHub
        </button>
      </div>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

/** A labelled group of setting cards, mirroring the "THEME" / "INTERFACE" sections. */
function SettingsGroup({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <section className="mb-6 last:mb-0">
      {label && (
        <h2 className="px-1 mb-3 text-[length:var(--text-2xs)] font-semibold uppercase tracking-wider text-text-muted">
          {label}
        </h2>
      )}
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

function SettingRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 rounded-xl bg-bg-surface border border-border/50">
      {children}
    </div>
  );
}

function Toggle({ id, checked, onChange }: { id: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      id={id}
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={[
        "relative w-9 h-5 rounded-full shrink-0",
        "transition-colors duration-[var(--duration-fast)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        checked ? "bg-accent" : "bg-bg-muted",
      ].join(" ")}
    >
      <span
        className={[
          "absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-[var(--shadow-sm)]",
          "transition-transform duration-[var(--duration-fast)]",
          checked ? "translate-x-4" : "translate-x-0",
        ].join(" ")}
      />
    </button>
  );
}

/** Segmented toggle for small option sets (e.g. theme, cursor style). */
function SegmentedControl<T extends string>({ id, value, onChange, options }: {
  id?: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div
      id={id}
      role="radiogroup"
      className="inline-flex shrink-0 gap-0.5 p-0.5 rounded-lg bg-bg-base border border-border"
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            data-testid={id ? `${id}-${opt.value}` : undefined}
            onClick={() => onChange(opt.value)}
            className={[
              "px-3 py-1.5 rounded-md text-[length:var(--text-sm)] font-medium",
              "transition-colors duration-[var(--duration-fast)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected
                ? "bg-bg-overlay text-text-primary shadow-[var(--shadow-sm)]"
                : "text-text-muted hover:text-text-primary",
            ].join(" ")}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Update checker ─────────────────────────────────────────────────────────

type UpdateStatus = "idle" | "checking" | "available" | "up-to-date" | "downloading" | "ready" | "error";

function UpdateChecker() {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [appVersion, setAppVersion] = useState<string | null>(null);

  // Read the real app version (injected from git tags at build) instead of hardcoding.
  useEffect(() => {
    void (async () => {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        setAppVersion(await getVersion());
      } catch { /* best-effort */ }
    })();
  }, []);

  const checkForUpdate = useCallback(async () => {
    setStatus("checking");
    setError(null);
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();

      if (update) {
        setVersion(update.version);
        setStatus("available");
      } else {
        setStatus("up-to-date");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to check for updates");
      setStatus("error");
    }
  }, []);

  const installUpdate = useCallback(async () => {
    setStatus("downloading");
    setProgress(0);
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) return;

      let downloaded = 0;
      let totalBytes = 0;

      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          totalBytes = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (totalBytes > 0) {
            setProgress(Math.round((downloaded / totalBytes) * 100));
          }
        } else if (event.event === "Finished") {
          setStatus("ready");
        }
      });

      setStatus("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
      setStatus("error");
    }
  }, []);

  const handleRelaunch = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("plugin:updater|restart");
    } catch {
      // Fallback: just tell the user to restart manually
    }
  }, []);

  return (
    <div className="px-4 py-3 rounded-xl bg-bg-surface border border-border/50">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className={LABEL_CLASS}>App Version</p>
          <p className={DESC_CLASS}>
            {status === "up-to-date" && "You're on the latest version"}
            {status === "available" && `v${version} is available`}
            {status === "downloading" && `Downloading update... ${progress}%`}
            {status === "ready" && "Update downloaded. Restart to apply."}
            {status === "error" && (error ?? "Something went wrong")}
            {(status === "idle" || status === "checking") && (appVersion ? `Current: v${appVersion}` : "Reading version…")}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Status icon */}
          {status === "up-to-date" && (
            <CheckCircle2 size={15} strokeWidth={2} className="text-status-connected shrink-0" />
          )}
          {status === "error" && (
            <AlertCircle size={15} strokeWidth={2} className="text-status-error shrink-0" />
          )}

          {/* Action button */}
          {(status === "idle" || status === "up-to-date" || status === "error") && (
            <button
              onClick={() => void checkForUpdate()}
              className={[
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg",
                "text-[length:var(--text-sm)] font-medium",
                "bg-bg-base border border-border text-text-secondary",
                "hover:text-text-primary hover:border-border-focus",
                "transition-all duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              ].join(" ")}
            >
              <RefreshCw size={13} strokeWidth={2} />
              Check
            </button>
          )}

          {status === "checking" && (
            <span className="flex items-center gap-1.5 px-3 py-1.5 text-[length:var(--text-sm)] font-medium text-text-muted">
              <RefreshCw size={13} strokeWidth={2} className="motion-safe:animate-spin" />
              Checking...
            </span>
          )}

          {status === "available" && (
            <button
              onClick={() => void installUpdate()}
              className={[
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg",
                "text-[length:var(--text-sm)] font-medium",
                "bg-accent text-text-inverse",
                "hover:bg-accent-hover",
                "transition-all duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              ].join(" ")}
            >
              <Download size={13} strokeWidth={2} />
              Update to v{version}
            </button>
          )}

          {status === "downloading" && (
            <div className="w-24 h-1.5 rounded-full bg-bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-200"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}

          {status === "ready" && (
            <button
              onClick={() => void handleRelaunch()}
              className={[
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg",
                "text-[length:var(--text-sm)] font-medium",
                "bg-status-connected text-text-inverse",
                "hover:opacity-90",
                "transition-all duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              ].join(" ")}
            >
              Restart Now
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Number input that uses local state while typing, commits on blur/Enter. */
function NumberSetting({ id, value, min, max, step, onChange }: {
  id: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  const [local, setLocal] = useState(String(value));

  // Sync from store when value changes externally
  useEffect(() => {
    setLocal(String(value));
  }, [value]);

  const commit = () => {
    const n = Number(local);
    if (isNaN(n)) {
      setLocal(String(value)); // revert
      return;
    }
    const clamped = Math.max(min, Math.min(max, n));
    onChange(clamped);
    setLocal(String(clamped));
  };

  return (
    <input
      id={id}
      data-testid={id}
      type="text"
      inputMode="decimal"
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
          (e.target as HTMLInputElement).blur();
        }
        // Arrow keys for increment/decrement
        if (e.key === "ArrowUp") {
          e.preventDefault();
          const next = Math.min(max, Number(local) + step);
          setLocal(String(Number(next.toFixed(2))));
          onChange(next);
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          const next = Math.max(min, Number(local) - step);
          setLocal(String(Number(next.toFixed(2))));
          onChange(next);
        }
      }}
      className={INPUT_CLASS}
    />
  );
}
