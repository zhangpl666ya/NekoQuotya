import type { PackSnapshot, SessionDay, TokenBucket } from './types.ts';
import { activeTokens, addInto, emptyBucket, localDate, shiftDate } from './usage.ts';

// Usage by period and by session, computed from a pack's ledger (history.json)
// plus today (today.json). Pure functions, shared by the launcher and the session window.
//   today  the current local day
//   week   Monday of this week through today
//   month  the 1st of this month through today
//   total  everything in the ledger plus today

export type Period = 'today' | 'week' | 'month' | 'total';
export const PERIODS: Period[] = ['today', 'week', 'month', 'total'];

export interface Totals extends TokenBucket {
  /** input + output, excluding cache */
  active: number;
  sessions: number;
}

export interface SessionRow {
  key: string;
  client: string;
  sessionId: string;
  firstDate: string;
  lastDate: string;
  usage: Totals;
  models: string[];
  /** The session's logs are gone; at least part of its usage is retained ledger data */
  retained: boolean;
}

/** First day of the period (inclusive), or null for "total" */
export function periodStart(period: Period, today: string): string | null {
  switch (period) {
    case 'today':
      return today;
    case 'week': {
      const [y, m, d] = today.split('-').map(Number) as [number, number, number];
      const weekday = (new Date(y, m - 1, d).getDay() + 6) % 7; // Monday = 0
      return shiftDate(today, -weekday);
    }
    case 'month':
      return `${today.slice(0, 8)}01`;
    case 'total':
      return null;
  }
}

/** Every day with usage in the period: ledger days plus today (today.json wins for the current day) */
function daysIn(snapshot: PackSnapshot, period: Period, now: number): Array<{ date: string; sessions: Record<string, SessionDay> }> {
  const today = localDate(now);
  const from = periodStart(period, today);
  const days: Array<{ date: string; sessions: Record<string, SessionDay> }> = [];
  for (const day of Object.values(snapshot.history?.days ?? {})) {
    if (day.date >= today) continue;
    if (from && day.date < from) continue;
    days.push({ date: day.date, sessions: day.sessions });
  }
  if (snapshot.today?.date === today) days.push({ date: today, sessions: snapshot.today.sessions });
  return days;
}

export function totalsOf(bucket: TokenBucket, sessions: number): Totals {
  return { ...bucket, active: activeTokens(bucket), sessions };
}

export function periodTotals(snapshot: PackSnapshot, period: Period, now: number): Totals {
  const sum = emptyBucket();
  const keys = new Set<string>();
  for (const day of daysIn(snapshot, period, now)) {
    for (const [key, s] of Object.entries(day.sessions)) {
      keys.add(key);
      for (const b of Object.values(s.byModel)) addInto(sum, b);
    }
  }
  return totalsOf(sum, keys.size);
}

export function allPeriodTotals(snapshot: PackSnapshot, now: number): Record<Period, Totals> {
  return {
    today: periodTotals(snapshot, 'today', now),
    week: periodTotals(snapshot, 'week', now),
    month: periodTotals(snapshot, 'month', now),
    total: periodTotals(snapshot, 'total', now),
  };
}

/** One row per session in the period, summed over its days; most active tokens first */
export function sessionRows(snapshot: PackSnapshot, period: Period, now: number): SessionRow[] {
  const rows = new Map<string, { row: SessionRow; bucket: TokenBucket; models: Set<string> }>();
  for (const day of daysIn(snapshot, period, now)) {
    for (const [key, s] of Object.entries(day.sessions)) {
      let entry = rows.get(key);
      if (!entry) {
        entry = {
          row: { key, client: s.client, sessionId: s.sessionId, firstDate: day.date, lastDate: day.date, usage: totalsOf(emptyBucket(), 1), models: [], retained: false },
          bucket: emptyBucket(),
          models: new Set(),
        };
        rows.set(key, entry);
      }
      if (day.date < entry.row.firstDate) entry.row.firstDate = day.date;
      if (day.date > entry.row.lastDate) entry.row.lastDate = day.date;
      if (s.retained) entry.row.retained = true;
      for (const [model, b] of Object.entries(s.byModel)) {
        addInto(entry.bucket, b);
        entry.models.add(model);
      }
    }
  }
  return [...rows.values()]
    .map(({ row, bucket, models }) => ({ ...row, usage: totalsOf(bucket, 1), models: [...models].sort() }))
    .sort((a, b) => b.usage.active - a.usage.active || b.lastDate.localeCompare(a.lastDate));
}
