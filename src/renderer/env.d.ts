import type { LauncherApi } from '../preload/launcher.ts';
import type { PetApi } from '../preload/pet.ts';
import type { SessionsApi } from '../preload/sessions.ts';
import type { SettingsApi } from '../preload/settings.ts';

// The APIs the preload scripts expose to each window (src/preload/).

declare global {
  interface Window {
    nekoPet: PetApi;
    nekoLauncher: LauncherApi;
    nekoSessions: SessionsApi;
    nekoSettings: SettingsApi;
  }
}

export {};
