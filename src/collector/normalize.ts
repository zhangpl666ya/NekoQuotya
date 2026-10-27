import { sessionKey, type ScannedSession } from '../shared/ledger.ts';
import type { QuotaKind, QuotaWindow, TokenBucket } from '../shared/types.ts';
import { addInto, emptyBucket } from '../shared/usage.ts';
import type { TokscaleSessionReport, TokscaleUsage } from './schema.ts';

// tokscale output → the core's data vocabulary (src/shared/types.ts).

interface RawCounts {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  messages: number;
  cost: number;
}

/** tokscale lists reasoning tokens separately from output; add them back into output */
export function toBucket(raw: RawCounts): TokenBucket {
  return {
    input: raw.input,
    output: raw.output + raw.reasoning,
    cacheRead: raw.cacheRead,
    cacheWrite: raw.cacheWrite,
    messages: raw.messages,
    costUsd: raw.cost,
  };
}

/**
 * Group a report by session, keeping only rows for the given clients. A session
 * may use several models; repeated (session, model) rows are added up. Rows with
 * no tokens at all are dropped.
 */
export function reportToSessions(report: TokscaleSessionReport, clients: string[]): Map<string, ScannedSession> {
  const wanted = new Set(clients);
  const sessions = new Map<string, ScannedSession>();
  for (const e of report.entries) {
    if (!wanted.has(e.client)) continue;
    const bucket = toBucket({ ...e, messages: e.messageCount });
    if (!bucket.input && !bucket.output && !bucket.cacheRead && !bucket.cacheWrite) continue;
    const key = sessionKey(e.client, e.sessionId);
    let s = sessions.get(key);
    if (!s) {
      s = { client: e.client, sessionId: e.sessionId, byModel: {} };
      sessions.set(key, s);
    }
    addInto((s.byModel[e.model] ??= emptyBucket()), bucket);
  }
  return sessions;
}

export function findProvider(usage: TokscaleUsage, provider: string) {
  const want = provider.toLowerCase();
  return usage.find((p) => p.provider.toLowerCase() === want) ?? null;
}

export function usageToQuota(
  entry: NonNullable<ReturnType<typeof findProvider>>,
  now: number
): { plan: string | null; windows: QuotaWindow[] } {
  const windows = entry.metrics.map((m): QuotaWindow => {
    const resetsAt = parseReset(m.resets_at);
    let used = m.used_percent ?? (m.remaining_percent != null ? 100 - m.remaining_percent : null);
    if (used != null) used = Math.min(100, Math.max(0, Math.round(used * 10) / 10));
    return {
      kind: classifyWindow(m.label),
      rawLabel: m.label.trim(),
      usedPercent: used,
      resetsAt,
      applicable: !isEmptyAllowance(m.remaining_label),
      stale: resetsAt != null && resetsAt <= now,
    };
  });
  return { plan: cleanPlan(entry.plan), windows };
}

export function classifyWindow(raw: string): QuotaKind {
  const s = raw.trim().toLowerCase();
  if (/^(session|5\s*h|5[-\s]?hours?)$/.test(s)) return 'session';
  if (/^(weekly|week|7\s*d)$/.test(s)) return 'weekly';
  if (/^(monthly|month)$/.test(s)) return 'monthly';
  return 'other';
}

/** "0/0 left" means the plan does not include this allowance at all (e.g. Copilot free tier Premium) */
function isEmptyAllowance(remainingLabel: string | null | undefined): boolean {
  return !!remainingLabel && /^\s*0\s*\/\s*0\b/.test(remainingLabel);
}

/** Full timestamps keep their own time zone; a bare date means local midnight */
export function parseReset(value: string | null | undefined): number | null {
  if (!value) return null;
  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return new Date(Number(y), Number(m) - 1, Number(d)).getTime();
  }
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

/** tokscale's plan names sometimes carry a stray suffix (Claude was measured returning "Pro ai") */
export function cleanPlan(plan: string | null | undefined): string | null {
  if (!plan || !plan.trim()) return null;
  const known = plan.trim().match(/^(free|pro|max|plus|team|enterprise|business|individual)\b/i)?.[1];
  if (known) return known[0]!.toUpperCase() + known.slice(1).toLowerCase();
  return plan.trim();
}
