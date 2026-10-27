// Channel names for the session window. Kept apart from the other windows' so the
// preload bundles share no module (see electron.vite.config.ts).

export const SESSION_CHANNELS = {
  get: 'sessions:get', //         renderer → main (invoke, Period): SessionsView
  changed: 'sessions:changed', // main → renderer: new data is available, ask again
} as const;
