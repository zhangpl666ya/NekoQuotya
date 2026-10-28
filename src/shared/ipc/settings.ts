// Channel names for the settings window. Kept apart from the other windows' so the
// preload bundles share no module (see electron.vite.config.ts).

export const SETTINGS_CHANNELS = {
  get: 'settings:get', //             renderer → main (invoke): SettingsView
  save: 'settings:save', //           renderer → main (invoke, SettingsSave): SettingsView
  setActive: 'settings:setActive', // renderer → main (invoke, pack id | null): SettingsView, the pet shown on the desktop
  setLanguage: 'settings:setLanguage', // renderer → main (invoke, LanguageChoice): SettingsView, applied to every window
  resize: 'settings:resize', //       renderer → main: content height in px, so the window fits its content
  close: 'settings:close', //         renderer → main: close the (frameless) window
} as const;
