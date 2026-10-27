// Channel names for the launcher panel. Kept apart from the pet's so the two
// preload bundles share no module (see electron.vite.config.ts).

export const LAUNCHER_CHANNELS = {
  state: 'launcher:state', //   main → renderer: LauncherState
  get: 'launcher:get', //       renderer → main (invoke): LauncherState
  command: 'launcher:cmd', //   renderer → main: LauncherCommand
} as const;
