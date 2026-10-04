import { SettingsPage } from "anyscp";

// Section state is internal (defaults to Appearance); settings come from the
// store defaults since load_all_settings resolves {}.
export const Appearance = () => (
  <div className="bg-bg-base" style={{ width: 1280, height: 800 }}>
    <SettingsPage />
  </div>
);
