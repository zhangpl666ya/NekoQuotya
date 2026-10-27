import type { TokenBucket } from './types.ts';

export function emptyBucket(): TokenBucket {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, costUsd: 0 };
}

export function addInto(target: TokenBucket, part: TokenBucket): TokenBucket {
  target.input += part.input;
  target.output += part.output;
  target.cacheRead += part.cacheRead;
  target.cacheWrite += part.cacheWrite;
  target.messages += part.messages;
  target.costUsd += part.costUsd;
  return target;
}

/** Active tokens: input + output, excluding cache. The pet's daily budget uses this. */
export function activeTokens(bucket: TokenBucket): number {
  return bucket.input + bucket.output;
}

/** Local date as YYYY-MM-DD */
export function localDate(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Add days to a local date by calendar, unaffected by daylight saving */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return localDate(new Date(y, m - 1, d + days, 12).getTime());
}

/** Timestamp of the next local midnight */
export function nextLocalMidnight(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}
