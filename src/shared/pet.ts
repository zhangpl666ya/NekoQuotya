// The pet's vocabulary, shared by the brain (decides) and renderers (display).
// The brain outputs ids and line keys only; renderers map them to visuals, and
// lines are looked up in the pack's lines/<locale>.json (docs/architecture.md §2.3).

export const MOODS = ['ENERGETIC', 'FOCUSED', 'SWEATING', 'PANICKED', 'EXHAUSTED'] as const;
export type MoodId = (typeof MOODS)[number];

/** Independent of mood: e.g. SWEATING + working, or ENERGETIC + sleeping */
export type ActivityId = 'working' | 'idle' | 'sleeping';

export type ActionId =
  | 'poked'
  | 'dragged'
  | 'landed'
  | 'eat'
  | 'alert'
  | 'celebrate'
  | 'wake'
  | 'newDay';

/**
 * Every line key the brain can emit. Pack authors write one or more lines per key
 * in lines/<locale>.json; one is picked at random each time.
 *   mood.<MOOD>          mood changes and idle chatter
 *   event.quota.<N>      quota crossed N% (N from behavior.alertThresholds)
 */
export type LineKey =
  | `mood.${MoodId}`
  | 'user.poke'
  | 'user.pokeAnnoyed'
  | 'user.drag'
  | 'user.land'
  | 'event.eat'
  | `event.quota.${number}`
  | 'event.quota.reset'
  | 'event.wake'
  | 'event.newDay';

export interface PetIntent {
  mood: MoodId;
  activity: ActivityId;
  /** One-off action; null = show the mood's idle visual */
  action: { id: ActionId; startedAt: number; until: number | null } | null;
  /** Speech bubble; `id` changes for every new bubble so renderers pick a fresh line variant */
  bubble: { id: number; lineKey: LineKey; params?: Record<string, string | number>; until: number } | null;
  info: {
    basis: 'quota' | 'budget';
    /** Pressure in percent (quota used % or today / budget) */
    pressure: number;
    todayTokens: number;
    /** The quota behind the mood is not current; the mood is frozen */
    stale: boolean;
  };
}
