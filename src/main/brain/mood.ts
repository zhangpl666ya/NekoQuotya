import type { PackManifest } from '../../shared/packs/manifest.ts';
import { MOODS, type MoodId } from '../../shared/pet.ts';
import type { PackSnapshot, QuotaWindow } from '../../shared/types.ts';
import { activeTokens, localDate } from '../../shared/usage.ts';

// Pressure and mood (docs/architecture.md §4).
//   pressure = with a usable quota: the highest used % among the 5-hour / weekly / monthly windows
//              otherwise:           today's active tokens / daily budget
//   mood     = pressure mapped onto five levels, stepping down only after dropping
//              `moodHysteresis` points below a threshold so it does not flicker.

export type BrainRules = PackManifest['behavior'];

export interface Pressure {
  basis: 'quota' | 'budget';
  /** Percent; may exceed 100 on the budget basis */
  pressure: number;
  todayTokens: number;
  /** Quota-based pressure from stale data: the mood must stay where it is */
  stale: boolean;
}

/** Quota windows that can drive the mood: included in the plan, with a known percentage */
export function moodWindows(windows: QuotaWindow[]): QuotaWindow[] {
  return windows.filter((w) => w.applicable && w.kind !== 'other' && w.usedPercent != null);
}

export function computePressure(snapshot: PackSnapshot, rules: BrainRules, now: number): Pressure {
  const today = snapshot.today;
  const todayTokens = today && today.date === localDate(now) ? activeTokens(today.total) : 0;

  const quota = snapshot.quota;
  const windows = rules.moodBasis === 'quota' && quota ? moodWindows(quota.windows) : [];
  if (windows.length) {
    return {
      basis: 'quota',
      pressure: Math.max(...windows.map((w) => w.usedPercent!)),
      todayTokens,
      // Once the quota has been seen, stale quota keeps the quota basis instead of switching to the budget
      stale: !!quota!.error || windows.some((w) => w.stale),
    };
  }
  return { basis: 'budget', pressure: (todayTokens / rules.dailyBudget) * 100, todayTokens, stale: false };
}

/** Move from `level` (0–4) towards the level for `pressure`: up immediately, down only past the hysteresis */
export function stepMood(level: number, pressure: number, thresholds: readonly number[], hysteresis: number): number {
  let next = level;
  while (next < thresholds.length && pressure >= thresholds[next]!) next++;
  while (next > 0 && pressure < thresholds[next - 1]! - hysteresis) next--;
  return next;
}

/** The level for a pressure with no history (used on start) */
export function initialMoodLevel(pressure: number, thresholds: readonly number[]): number {
  return thresholds.filter((t) => pressure >= t).length;
}

export function moodOf(level: number): MoodId {
  return MOODS[Math.max(0, Math.min(MOODS.length - 1, level))]!;
}
