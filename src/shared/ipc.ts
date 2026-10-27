import type { ErrorInfo } from './errors.ts';
import type { Locale } from './i18n/index.ts';
import type { ImageAppearance } from './appearance.ts';
import type { PetIntent } from './pet.ts';
import type { PackLoadError } from './packs/registry.ts';
import type { QuotaWindow, StatusData } from './types.ts';
import type { Behavior, BehaviorOverride, EDITABLE_BEHAVIOR } from './packs/manifest.ts';
import type { Period, SessionRow, Totals } from './stats.ts';
import { LAUNCHER_CHANNELS } from './ipc/launcher.ts';
import { PET_CHANNELS } from './ipc/pet.ts';
import { SESSION_CHANNELS } from './ipc/sessions.ts';
import { SETTINGS_CHANNELS } from './ipc/settings.ts';

// Every message crossing a process boundary. Renderers only see the narrow
// APIs their preload scripts expose (src/preload/). Channel names are defined
// per window in ipc/pet.ts and ipc/launcher.ts; this combined view is for the
// main process.

export const IPC = {
  petInit: PET_CHANNELS.init,
  petIntent: PET_CHANNELS.intent,
  petIgnoreMouse: PET_CHANNELS.ignoreMouse,
  petPointer: PET_CHANNELS.pointer,
  petHud: PET_CHANNELS.hud,
  launcherState: LAUNCHER_CHANNELS.state,
  launcherGet: LAUNCHER_CHANNELS.get,
  launcherCommand: LAUNCHER_CHANNELS.command,
  sessionsGet: SESSION_CHANNELS.get,
  sessionsChanged: SESSION_CHANNELS.changed,
  settingsGet: SETTINGS_CHANNELS.get,
  settingsSave: SETTINGS_CHANNELS.save,
  settingsSetActive: SETTINGS_CHANNELS.setActive,
  settingsResize: SETTINGS_CHANNELS.resize,
  settingsClose: SETTINGS_CHANNELS.close,
} as const;

/** The session window's data for one period */
export interface SessionsView {
  locale: Locale;
  packName: string;
  theme: { color: string; gradient?: string[] };
  period: Period;
  totals: Totals;
  rows: SessionRow[];
  /** More sessions exist than are listed */
  truncated: boolean;
}

export type EditableBehavior = Pick<Behavior, (typeof EDITABLE_BEHAVIOR)[number]>;

export interface SettingsPackView {
  id: string;
  name: string;
  theme: { color: string; gradient?: string[] };
  /** The tool has a subscription quota; without one the mood always follows the daily budget */
  hasQuota: boolean;
  /** Current values (pack.json with the user's overrides applied) */
  values: EditableBehavior;
  /** The pack's own values, for "reset to defaults" */
  defaults: EditableBehavior;
}

export interface SettingsView {
  locale: Locale;
  packs: SettingsPackView[];
  /** The pack whose pet is on the desktop; only one is shown at a time. null = none */
  activePackId: string | null;
}

/** An empty override resets the pack to its own defaults */
export interface SettingsSave {
  packId: string;
  override: BehaviorOverride;
}

export interface PetInit {
  packId: string;
  locale: Locale;
  renderer: 'placeholder' | 'image';
  /** Only for the image renderer */
  appearance: ImageAppearance | null;
  /** Base URL for the pack's appearance assets (neko-pack://<id>/) */
  assetBase: string;
  /** Lines for the current language, already merged with English and the core defaults */
  lines: Record<string, string[]>;
  intent: PetIntent;
  /** The tool's brand colour, for the quota widget */
  theme: { color: string; gradient?: string[] };
  hud: PetHud;
}

/** The small quota widget beside the pet: up to two quota bars, or today's tokens without a quota */
export interface PetHud {
  windows: Array<Pick<QuotaWindow, 'kind' | 'rawLabel' | 'usedPercent' | 'stale'>>;
  todayTokens: number;
}

export type PetPointer =
  | { type: 'poke' }
  | { type: 'dragStart' }
  | { type: 'dragEnd' }
  | { type: 'menu' }
  | { type: 'openLauncher' };

export interface LauncherPack {
  id: string;
  name: string;
  /** The tool's brand colour (pack.json → theme) */
  theme: { color: string; gradient?: string[] };
  /** Faded illustration on the card (neko-pack:// URL), if the pack has one */
  cardArt: string | null;
  petVisible: boolean;
  mood: PetIntent['mood'] | null;
  activity: PetIntent['activity'] | null;
  /** Token usage per period; null until the first data arrives */
  usage: Record<Period, Totals> | null;
  quota: { plan: string | null; windows: QuotaWindow[]; error: ErrorInfo | null; checking: boolean } | null;
  status: { lastError: StatusData['lastError']; warnings: string[]; retainedSessions: number } | null;
}

export interface LauncherState {
  locale: Locale;
  packs: LauncherPack[];
  loadErrors: PackLoadError[];
  refreshing: boolean;
  autostart: boolean;
  /** Launch-at-startup only makes sense for the installed app, not a dev run */
  autostartAvailable: boolean;
}

export type LauncherCommand =
  | { type: 'togglePet'; packId: string }
  | { type: 'openSessions'; packId: string }
  | { type: 'openSettings' }
  /** New card order, every pack id once (dragged in the panel) */
  | { type: 'reorder'; order: string[] }
  | { type: 'refreshNow' }
  | { type: 'setAutostart'; enabled: boolean }
  | { type: 'quit' };

/** Messages between the main process and the collector utility process */
export type CollectorRequest =
  | { type: 'start'; packsRoot: string }
  | { type: 'refreshNow' }
  | { type: 'resync' }
  | { type: 'stop' };
