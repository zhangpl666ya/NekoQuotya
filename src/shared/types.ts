import type { ErrorInfo } from './errors.ts';

// The core's single data vocabulary. tokscale output is converted into these
// shapes in collector/normalize.ts; everything downstream (ledger, pet
// behavior, UI) only sees these types. Data files hold no display text:
// windows are identified by `kind`, errors by `code` (see i18n/).

export interface TokenBucket {
  /** Input that was not served from cache */
  input: number;
  /** Output including reasoning tokens (tokscale lists reasoning separately; added back here) */
  output: number;
  cacheRead: number;
  cacheWrite: number;
  messages: number;
  /** Estimated from public list prices; for reference only */
  costUsd: number;
}

export type QuotaKind = 'session' | 'weekly' | 'monthly' | 'other';

export interface QuotaWindow {
  kind: QuotaKind;
  /** tokscale's original label; shown as-is for kind "other" */
  rawLabel: string;
  usedPercent: number | null;
  /** Epoch milliseconds */
  resetsAt: number | null;
  /** false for allowances the plan does not include ("0/0") */
  applicable: boolean;
  /** The last query failed and this is the previous value, or the reset time has passed */
  stale: boolean;
}

// ---- Session ledger (docs/architecture.md §3.5) -----------------------------

/** One session's usage on one day */
export interface SessionDay {
  client: string;
  sessionId: string;
  byModel: Record<string, TokenBucket>;
  firstSeenAt: number;
  /** Last scan that still found this session */
  lastSeenAt: number;
  /** true = the latest scan no longer finds it (logs cleaned up); values are retained */
  retained: boolean;
}

/** One day's ledger; sessions keyed by "client:sessionId" */
export interface DayLedger {
  date: string;
  /** Last time this day was scanned */
  scannedAt: number;
  sessions: Record<string, SessionDay>;
}

// ---- Files written to packs/<id>/data/ --------------------------------------

export interface TodayData {
  schema: 1;
  date: string;
  sessions: Record<string, SessionDay>;
  /** Sum of sessions, precomputed for display */
  total: TokenBucket;
  /** Last time usage was seen to grow */
  lastActivityAt: number | null;
  scannedAt: number;
  /** tokscale version that produced the session ids */
  scannedWith: string | null;
}

export interface HistoryData {
  schema: 1;
  /** Finished days only; today lives in today.json */
  days: Record<string, DayLedger>;
  /** This day and all earlier days were scanned after they ended; null = never caught up */
  verifiedThrough: string | null;
  /** tokscale version of the last full verification; a change triggers re-verification */
  verifiedWith: string | null;
  /** Date of the last late-arrival check */
  lateCheckedOn: string | null;
  updatedAt: number;
}

export interface QuotaData {
  schema: 1;
  provider: string;
  plan: string | null;
  windows: QuotaWindow[];
  /** Last successful query */
  observedAt: number | null;
  lastAttemptAt: number;
  error: ErrorInfo | null;
}

export type WatchMode = 'native' | 'polling' | 'none';
export type Stage = 'today' | 'history' | 'quota' | 'version' | 'lock';

export interface StatusData {
  schema: 1;
  tokscaleVersion: string | null;
  watch: WatchMode;
  watchRoots: Array<{ path: string; exists: boolean }>;
  history: {
    days: number;
    sessions: number;
    /** Sessions whose logs are gone and that only exist in the ledger */
    retainedSessions: number;
    verifiedThrough: string | null;
    /** Set when the ledger had to be restored from a backup */
    recoveredFrom: string | null;
  };
  /** Hints tokscale printed on stderr (e.g. files without usage records); raw text */
  warnings: string[];
  lastError: ({ at: number; stage: Stage } & ErrorInfo) | null;
  updatedAt: number;
}

export interface PackSnapshot {
  packId: string;
  today: TodayData | null;
  history: HistoryData | null;
  quota: QuotaData | null;
  status: StatusData | null;
}

/** A day summed up for display (computed from the ledger, never stored) */
export interface DayUsage {
  date: string;
  total: TokenBucket;
  byModel: Record<string, TokenBucket>;
  sessions: number;
  retainedSessions: number;
}
