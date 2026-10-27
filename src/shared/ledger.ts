import type { DayLedger, DayUsage, HistoryData, SessionDay, TokenBucket } from './types.ts';
import { addInto, emptyBucket, shiftDate } from './usage.ts';

// Pure session-ledger logic (docs/architecture.md §3.5); no file I/O, so it can
// be tested in isolation.
//
// One merge rule: sessions are never deleted from the ledger.
//   session present in the scan → replaced with the scanned values, retained = false
//   session absent from the scan → previous values kept,           retained = true

export interface ScannedSession {
  client: string;
  sessionId: string;
  byModel: Record<string, TokenBucket>;
}

export function sessionKey(client: string, sessionId: string): string {
  return `${client}:${sessionId}`;
}

export function mergeSessions(
  existing: Record<string, SessionDay>,
  scanned: Map<string, ScannedSession>,
  now: number
): Record<string, SessionDay> {
  const merged: Record<string, SessionDay> = {};
  for (const [key, prev] of Object.entries(existing)) {
    merged[key] = scanned.has(key) || prev.retained ? prev : { ...prev, retained: true };
  }
  for (const [key, s] of scanned) {
    merged[key] = {
      client: s.client,
      sessionId: s.sessionId,
      byModel: s.byModel,
      firstSeenAt: existing[key]?.firstSeenAt ?? now,
      lastSeenAt: now,
      retained: false,
    };
  }
  return merged;
}

/** Relative difference within which "lost" and "new" sessions count as the same usage */
export const RENAME_TOLERANCE = 0.02;

/**
 * After a tokscale upgrade, the same sessions may come back under new ids. Plain
 * merging would retain the old ids *and* add the new ones, counting the usage
 * twice. Per client: if the sessions that just went missing and the sessions
 * that just appeared add up to (almost) the same tokens, treat it as a rename
 * and drop the old ids. Only call this when the tokscale version changed.
 */
export function reconcileRenames(
  before: Record<string, SessionDay>,
  merged: Record<string, SessionDay>,
  scanned: Map<string, ScannedSession>
): { sessions: Record<string, SessionDay>; renamed: number } {
  const lostByClient = new Map<string, string[]>();
  const newByClient = new Map<string, string[]>();
  for (const [key, prev] of Object.entries(before)) {
    if (!prev.retained && !scanned.has(key)) push(lostByClient, prev.client, key);
  }
  for (const [key, s] of scanned) {
    if (!(key in before)) push(newByClient, s.client, key);
  }

  const sessions = { ...merged };
  let renamed = 0;
  for (const [client, lost] of lostByClient) {
    const added = newByClient.get(client);
    if (!added?.length) continue;
    const lostTokens = sumTokens(lost.map((k) => merged[k]!));
    const addedTokens = sumTokens(added.map((k) => merged[k]!));
    const largest = Math.max(lostTokens, addedTokens);
    if (largest > 0 && Math.abs(lostTokens - addedTokens) <= largest * RENAME_TOLERANCE) {
      for (const k of lost) delete sessions[k];
      renamed += lost.length;
    }
  }
  return { sessions, renamed };
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function sumTokens(sessions: SessionDay[]): number {
  let n = 0;
  for (const s of sessions) for (const b of Object.values(s.byModel)) n += b.input + b.output + b.cacheRead + b.cacheWrite;
  return n;
}

export function sumSessions(sessions: Record<string, SessionDay>) {
  const total = emptyBucket();
  const byModel: Record<string, TokenBucket> = {};
  let retained = 0;
  for (const s of Object.values(sessions)) {
    if (s.retained) retained++;
    for (const [model, bucket] of Object.entries(s.byModel)) {
      addInto(total, bucket);
      addInto((byModel[model] ??= emptyBucket()), bucket);
    }
  }
  return { total, byModel, sessions: Object.keys(sessions).length, retainedSessions: retained };
}

/**
 * Merge a day's scan into its ledger entry. With detectRenames (tokscale
 * version changed), sessions that merely changed id are replaced, not doubled.
 */
export function mergeDay(
  day: DayLedger | undefined,
  date: string,
  scanned: Map<string, ScannedSession>,
  now: number,
  detectRenames = false
): { day: DayLedger; renamed: number } {
  const before = day?.sessions ?? {};
  const merged = mergeSessions(before, scanned, now);
  const { sessions, renamed } = detectRenames ? reconcileRenames(before, merged, scanned) : { sessions: merged, renamed: 0 };
  return { day: { date, scannedAt: now, sessions }, renamed };
}

/** Per-day sums for from..to (inclusive); days without records are omitted */
export function summarizeDays(history: HistoryData | null, from: string, to: string): DayUsage[] {
  if (!history) return [];
  return Object.values(history.days)
    .filter((d) => d.date >= from && d.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({ date: d.date, ...sumSessions(d.sessions) }));
}

/** Every day from..to (inclusive), ascending */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = shiftDate(d, 1)) out.push(d);
  return out;
}

/** Catch-up: every day after verifiedThrough up to yesterday; the last backfillDays on first run */
export function daysToCatchUp(history: HistoryData | null, today: string, backfillDays: number): string[] {
  const yesterday = shiftDate(today, -1);
  const earliest = shiftDate(today, -backfillDays);
  const verified = history?.verifiedThrough;
  const from = verified && verified >= earliest ? shiftDate(verified, 1) : earliest;
  return from <= yesterday ? datesBetween(from, yesterday) : [];
}

/** Full re-verification: every date in the ledger plus the last backfillDays */
export function daysToReverify(history: HistoryData | null, today: string, backfillDays: number): string[] {
  const yesterday = shiftDate(today, -1);
  const dates = new Set(datesBetween(shiftDate(today, -backfillDays), yesterday));
  for (const date of Object.keys(history?.days ?? {})) if (date <= yesterday) dates.add(date);
  return [...dates].sort();
}

export function historyStats(history: HistoryData | null) {
  let sessions = 0;
  let retainedSessions = 0;
  for (const day of Object.values(history?.days ?? {})) {
    for (const s of Object.values(day.sessions)) {
      sessions++;
      if (s.retained) retainedSessions++;
    }
  }
  return {
    days: Object.keys(history?.days ?? {}).length,
    sessions,
    retainedSessions,
    verifiedThrough: history?.verifiedThrough ?? null,
  };
}

export function emptyHistory(now: number): HistoryData {
  return { schema: 1, days: {}, verifiedThrough: null, verifiedWith: null, lateCheckedOn: null, updatedAt: now };
}
