import { existsSync } from 'node:fs';
import { NekoError, toErrorInfo, type ErrorInfo } from '../shared/errors.ts';
import {
  daysToCatchUp,
  daysToReverify,
  emptyHistory,
  historyStats,
  mergeDay,
  mergeSessions,
  reconcileRenames,
  sumSessions,
} from '../shared/ledger.ts';
import type { LoadedPack } from '../shared/packs/registry.ts';
import type { HistoryData, PackSnapshot, QuotaData, Stage, StatusData, TodayData } from '../shared/types.ts';
import { activeTokens, localDate, shiftDate } from '../shared/usage.ts';
import { DataLock } from './dataLock.ts';
import { findProvider, reportToSessions, usageToQuota } from './normalize.ts';
import { PackStore } from './packStore.ts';
import { SessionReportSchema, UsageSchema, parseWith } from './schema.ts';
import { SourceWatcher, type WatcherOptions } from './sourceWatcher.ts';
import type { Runner } from './tokscaleRunner.ts';

// Scheduling (docs/architecture.md §3.2):
//   today     a watched log folder changed → scan today, merge by session into today.json;
//             fallback: rescan if today has not been scanned for 5 minutes
//   manual    refreshNow(): today + history catch-up + quota at once (quota skips backoff)
//   history   event-driven, never on a timer:
//               catch-up       startup / midnight / resume → every day after verifiedThrough up to yesterday
//               re-verify      tokscale version change / manual → every ledger date + the last 35 days
//               late arrival   packs with lateArrivalDays: the last N days, once a day
//   quota     every 5 minutes while active, otherwise 15; failures back off 5→15→30→60 minutes.
//             A provider missing from the output (e.g. Claude's endpoint answering 429) is a failure
//             too: polling through a rate limit keeps it locked for good.
//
// Ledger rule (§3.5): sessions are never deleted; found → updated, missing → retained.
// The scheduler emits structured events, never display text (see i18n/).

export type UpdateReason = 'cache' | 'today' | 'history' | 'quota' | 'status';
export type HistoryMode = 'catchup' | 'reverify';

export type SchedulerEvent =
  | { type: 'day_rollover'; from: string; to: string }
  | { type: 'resumed'; seconds: number }
  | { type: 'history_backfill'; from: string; to: string; count: number }
  | { type: 'version_changed'; packId: string; from: string; to: string }
  | { type: 'sessions_renamed'; packId: string; date: string; count: number }
  | { type: 'history_recovered'; packId: string; file: string }
  | { type: 'day_failed'; date: string; error: ErrorInfo }
  | { type: 'pack_error'; packId: string; stage: Stage; error: ErrorInfo };

export interface SchedulerIntervals {
  /** Fallback: rescan today if the last scan is older than this (in case the watcher missed a change) */
  todayFallbackMs: number;
  quotaActiveMs: number;
  quotaIdleMs: number;
  /** New usage within this window counts as "active" */
  activeWindowMs: number;
  /** Heartbeat checking for day changes, resume from sleep and quota resets */
  tickMs: number;
  quotaBackoffMs: number[];
}

export const DEFAULT_INTERVALS: SchedulerIntervals = {
  todayFallbackMs: 5 * 60_000,
  quotaActiveMs: 5 * 60_000,
  quotaIdleMs: 15 * 60_000,
  activeWindowMs: 10 * 60_000,
  tickMs: 30_000,
  quotaBackoffMs: [5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000],
};

/** Days scanned when a ledger is first created */
export const BACKFILL_DAYS = 35;
const MAX_WARNINGS = 10;

export interface SchedulerOptions {
  packs: LoadedPack[];
  runner: Runner;
  intervals?: Partial<SchedulerIntervals>;
  /** false: do not watch folders (one-shot runs and tests) */
  watch?: boolean;
  watcherOptions?: WatcherOptions;
  now?: () => number;
  onUpdate?: (snapshot: PackSnapshot, reason: UpdateReason) => void;
  onEvent?: (event: SchedulerEvent) => void;
}

interface PackState {
  pack: LoadedPack;
  store: PackStore;
  lock: DataLock;
  snapshot: PackSnapshot;
  watcher: SourceWatcher | null;
  /** Another process holds this pack's data folder: the pack is skipped entirely */
  locked: boolean;
  /** The ledger and all its backups are unreadable: never write history */
  historyBlocked: boolean;
  recoveredFrom: string | null;
  warnings: string[];
  /** Unresolved errors per stage */
  errors: Map<Stage, { at: number; error: ErrorInfo }>;
}

export class Scheduler {
  private readonly runner: Runner;
  private readonly intervals: SchedulerIntervals;
  private readonly watchEnabled: boolean;
  private readonly watcherOptions: WatcherOptions | undefined;
  private readonly now: () => number;
  private readonly onUpdate: SchedulerOptions['onUpdate'];
  private readonly onEvent: (event: SchedulerEvent) => void;
  private readonly states = new Map<string, PackState>();

  private tokscaleVersion: string | null = null;
  private currentDate: string;
  private lastTickAt = 0;
  private lastTodayScanAt = 0;
  private quotaFailures = 0;
  private stopped = false;

  private todayRunning: Promise<void> | null = null;
  private todayQueued = new Set<string>();
  private historyRunning: Promise<void> | null = null;
  private historyQueued: HistoryMode | null = null;
  private quotaRunning: Promise<void> | null = null;

  private quotaTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;

  constructor(options: SchedulerOptions) {
    this.runner = options.runner;
    this.intervals = { ...DEFAULT_INTERVALS, ...options.intervals };
    this.watchEnabled = options.watch ?? true;
    this.watcherOptions = options.watcherOptions;
    this.now = options.now ?? Date.now;
    this.onUpdate = options.onUpdate;
    this.onEvent = options.onEvent ?? (() => {});
    this.currentDate = localDate(this.now());
    for (const pack of options.packs) {
      this.states.set(pack.id, {
        pack,
        store: new PackStore(pack.id, pack.dataDir, this.now),
        lock: new DataLock(pack.dataDir),
        snapshot: { packId: pack.id, today: null, history: null, quota: null, status: null },
        watcher: null,
        locked: false,
        historyBlocked: false,
        recoveredFrom: null,
        warnings: [],
        errors: new Map(),
      });
    }
  }

  snapshot(packId: string): PackSnapshot | null {
    return this.states.get(packId)?.snapshot ?? null;
  }

  /** Lock and load data → refresh today, catch up history, query quota → start watching and timers */
  async start(): Promise<void> {
    await this.prepare();
    await this.refreshAll();
    if (this.stopped) return;

    if (this.watchEnabled) {
      for (const state of this.active()) {
        state.watcher = new SourceWatcher(
          { packId: state.pack.id, roots: state.pack.watchRoots },
          (packId) => void this.refreshToday([packId]),
          this.watcherOptions
        );
        state.watcher.start();
        await this.writeStatus(state);
      }
    }

    this.lastTickAt = this.now();
    this.tickTimer = setInterval(() => this.tick(), this.intervals.tickMs);
    this.armQuota();
  }

  /** One pass without watching or timers (one-shot runs) */
  async runOnce(options: { resync?: boolean } = {}): Promise<void> {
    await this.prepare();
    await this.refreshToday(this.activeIds());
    await this.syncHistory(options.resync ? 'reverify' : 'catchup');
    await this.refreshQuota();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.quotaTimer) clearTimeout(this.quotaTimer);
    this.tickTimer = this.quotaTimer = null;
    await Promise.all([...this.states.values()].map((s) => s.watcher?.close()));
    await Promise.allSettled([this.todayRunning, this.historyRunning, this.quotaRunning]);
    await this.runner.dispose();
    await Promise.all([...this.states.values()].map((s) => s.lock.release()));
  }

  async refreshAll(): Promise<void> {
    await this.refreshToday(this.activeIds());
    await this.syncHistory('catchup');
    await this.refreshQuota();
  }

  /** Manual "refresh now": today, history catch-up and quota; quota skips any backoff */
  async refreshNow(): Promise<void> {
    this.quotaFailures = 0;
    await this.refreshAll();
  }

  /** Manual "re-verify all history" */
  resyncAll(): Promise<void> {
    return this.syncHistory('reverify');
  }

  private active(): PackState[] {
    return [...this.states.values()].filter((s) => !s.locked);
  }

  private activeIds(): string[] {
    return this.active().map((s) => s.pack.id);
  }

  private async prepare(): Promise<void> {
    for (const state of this.states.values()) {
      try {
        await state.lock.acquire();
      } catch (err) {
        state.locked = true;
        await this.recordError(state, 'lock', err, { write: false });
      }
    }
    await this.loadData();
    await this.refreshVersion();
  }

  // ---- today -----------------------------------------------------------------

  /** Requests arriving during a scan are merged into one follow-up scan */
  refreshToday(packIds: string[]): Promise<void> {
    for (const id of packIds) if (this.states.get(id)?.locked === false) this.todayQueued.add(id);
    if (this.todayRunning) return this.todayRunning;
    this.todayRunning = (async () => {
      try {
        while (this.todayQueued.size && !this.stopped) {
          const batch = [...this.todayQueued];
          this.todayQueued.clear();
          await this.scanToday(batch);
        }
      } finally {
        this.todayRunning = null;
      }
    })();
    return this.todayRunning;
  }

  private async scanToday(packIds: string[]): Promise<void> {
    const states = packIds.map((id) => this.states.get(id)).filter((s): s is PackState => !!s);
    if (!states.length) return;
    const now = this.now();
    const date = localDate(now);
    this.lastTodayScanAt = now;
    try {
      const result = await this.runner.run({ kind: 'today', clients: this.clientsOf(states) });
      const report = parseWith(SessionReportSchema, result.stdout, 'today');
      for (const state of states) {
        const prev = state.snapshot.today;
        // First scan after midnight: move yesterday's today.json into the ledger before starting the new day
        if (prev && prev.date < date) await this.archiveToday(state);

        const scanned = reportToSessions(report, state.pack.manifest.source.tokscaleClients);
        const sameDay = prev?.date === date;
        const before = sameDay ? prev.sessions : {};
        let sessions = mergeSessions(before, scanned, now);
        if (sameDay && this.versionChangedSince(prev.scannedWith)) {
          const reconciled = reconcileRenames(before, sessions, scanned);
          sessions = reconciled.sessions;
          if (reconciled.renamed) this.onEvent({ type: 'sessions_renamed', packId: state.pack.id, date, count: reconciled.renamed });
        }
        const { total } = sumSessions(sessions);
        // Usage grew since the last scan → there was activity just now; unknown on the very first run
        const grew = sameDay ? activeTokens(total) > activeTokens(prev.total) : !!prev && activeTokens(total) > 0;
        const today: TodayData = {
          schema: 1,
          date,
          sessions,
          total,
          lastActivityAt: grew ? now : sameDay ? prev.lastActivityAt : null,
          scannedAt: now,
          scannedWith: this.tokscaleVersion,
        };
        state.snapshot = { ...state.snapshot, today };
        await state.store.write('today', today);
        const warnings = [...new Set(result.warnings)].slice(0, MAX_WARNINGS);
        if (warnings.join('\n') !== state.warnings.join('\n')) {
          state.warnings = warnings;
          await this.writeStatus(state);
        }
        await this.clearError(state, 'today');
        this.emit(state, 'today');
      }
    } catch (err) {
      for (const state of states) await this.recordError(state, 'today', err);
    }
  }

  /** Move a past day's today.json into the ledger: only sessions the ledger lacks; the ledger wins otherwise */
  private async archiveToday(state: PackState): Promise<void> {
    const today = state.snapshot.today;
    if (!today || state.historyBlocked || !Object.keys(today.sessions).length) return;
    const history = state.snapshot.history ?? emptyHistory(this.now());
    const existing = history.days[today.date];
    const day = existing ?? { date: today.date, scannedAt: today.scannedAt, sessions: {} };
    const sessions = { ...today.sessions, ...day.sessions };
    if (existing && Object.keys(sessions).length === Object.keys(existing.sessions).length) return;
    await this.saveHistory(state, {
      ...history,
      days: { ...history.days, [today.date]: { ...day, sessions } },
      updatedAt: this.now(),
    });
  }

  private versionChangedSince(version: string | null | undefined): boolean {
    return !!version && !!this.tokscaleVersion && version !== this.tokscaleVersion;
  }

  // ---- history ---------------------------------------------------------------

  /** Serial; a request arriving meanwhile runs afterwards, and re-verify outranks catch-up */
  syncHistory(mode: HistoryMode): Promise<void> {
    if (this.historyRunning) {
      if (this.historyQueued !== 'reverify') this.historyQueued = mode;
      return this.historyRunning;
    }
    this.historyRunning = (async () => {
      try {
        let next: HistoryMode | null = mode;
        while (next && !this.stopped) {
          this.historyQueued = null;
          await this.scanHistory(next);
          next = this.historyQueued;
        }
      } finally {
        this.historyRunning = null;
      }
    })();
    return this.historyRunning;
  }

  private async scanHistory(requested: HistoryMode): Promise<void> {
    const now = this.now();
    const today = localDate(now);
    const yesterday = shiftDate(today, -1);

    // Which days each pack needs
    const plans = new Map<PackState, { dates: Set<string>; mode: HistoryMode; late: boolean; renames: boolean }>();
    for (const state of this.active()) {
      if (state.historyBlocked) continue;
      if (state.snapshot.today && state.snapshot.today.date < today) await this.archiveToday(state);
      const history = state.snapshot.history;
      const versionChanged = this.versionChangedSince(history?.verifiedWith);
      const mode: HistoryMode = requested === 'reverify' || versionChanged ? 'reverify' : 'catchup';
      const dates = new Set(
        mode === 'reverify' ? daysToReverify(history, today, BACKFILL_DAYS) : daysToCatchUp(history, today, BACKFILL_DAYS)
      );
      const lateDays = state.pack.manifest.source.lateArrivalDays;
      const late = lateDays > 0 && history?.lateCheckedOn !== today;
      if (late) for (let i = 1; i <= lateDays; i++) dates.add(shiftDate(today, -i));
      if (dates.size || !history) plans.set(state, { dates, mode, late, renames: versionChanged });
      if (versionChanged) {
        this.onEvent({ type: 'version_changed', packId: state.pack.id, from: history!.verifiedWith!, to: this.tokscaleVersion! });
      }
    }
    if (!plans.size) return;

    const allDates = [...new Set([...plans.values()].flatMap((p) => [...p.dates]))].sort();
    if (allDates.length > 3) {
      this.onEvent({ type: 'history_backfill', from: allDates[0]!, to: allDates.at(-1)!, count: allDates.length });
    }

    // One tokscale call per day; results are split between packs by client
    const working = new Map<PackState, HistoryData>();
    for (const state of plans.keys()) working.set(state, state.snapshot.history ?? emptyHistory(now));
    const failed = new Map<PackState, string[]>();
    const warnings = new Set<string>();

    for (const date of allDates) {
      if (this.stopped) return;
      const targets = [...plans].filter(([, p]) => p.dates.has(date)).map(([s]) => s);
      try {
        const result = await this.runner.run({ kind: 'day', clients: this.clientsOf(targets), date });
        const report = parseWith(SessionReportSchema, result.stdout, date);
        result.warnings.forEach((w) => warnings.add(w));
        const scannedAt = this.now();
        for (const state of targets) {
          const history = working.get(state)!;
          const scanned = reportToSessions(report, state.pack.manifest.source.tokscaleClients);
          if (!scanned.size && !history.days[date]) continue; // no usage and no record: no empty entry
          const { day, renamed } = mergeDay(history.days[date], date, scanned, scannedAt, plans.get(state)!.renames);
          history.days = { ...history.days, [date]: day };
          if (renamed) this.onEvent({ type: 'sessions_renamed', packId: state.pack.id, date, count: renamed });
        }
      } catch (err) {
        for (const state of targets) failed.set(state, [...(failed.get(state) ?? []), date]);
        this.onEvent({ type: 'day_failed', date, error: toErrorInfo(err) });
      }
    }

    for (const [state, plan] of plans) {
      const history = working.get(state)!;
      const failures = (failed.get(state) ?? []).sort();
      const reached = failures[0] ? shiftDate(failures[0], -1) : yesterday;
      const prevVerified = history.verifiedThrough;
      const next: HistoryData = {
        ...history,
        // Days before the first failure count as verified; the next catch-up retries from there
        verifiedThrough: plan.mode === 'reverify' || !prevVerified || reached > prevVerified ? reached : prevVerified,
        verifiedWith:
          !failures.length && (plan.mode === 'reverify' || !history.verifiedWith) ? this.tokscaleVersion : history.verifiedWith,
        lateCheckedOn: plan.late && !failures.length ? today : history.lateCheckedOn,
        updatedAt: this.now(),
      };
      try {
        await this.saveHistory(state, next);
        if (warnings.size) state.warnings = [...new Set([...state.warnings, ...warnings])].slice(0, MAX_WARNINGS);
        if (failures.length) {
          await this.recordError(
            state,
            'history',
            new NekoError({ code: 'history_days_failed', params: { count: failures.length, dates: failures.join(', ') } })
          );
        } else {
          await this.clearError(state, 'history');
        }
      } catch (err) {
        await this.recordError(state, 'history', err);
      }
    }
  }

  private async saveHistory(state: PackState, history: HistoryData): Promise<void> {
    await state.store.write('history', history);
    state.snapshot = { ...state.snapshot, history };
    await this.writeStatus(state);
    this.emit(state, 'history');
  }

  // ---- quota -----------------------------------------------------------------

  refreshQuota(): Promise<void> {
    this.quotaRunning ??= this.scanQuota().finally(() => {
      this.quotaRunning = null;
    });
    return this.quotaRunning;
  }

  private async scanQuota(): Promise<void> {
    const states = this.active().filter((s) => s.pack.manifest.source.quotaProvider);
    if (!states.length) return;
    const now = this.now();
    try {
      const result = await this.runner.run({ kind: 'usage' });
      const usage = parseWith(UsageSchema, result.stdout, 'usage');
      let missing = false;
      for (const state of states) {
        const provider = state.pack.manifest.source.quotaProvider!;
        const entry = findProvider(usage, provider);
        if (!entry) {
          missing = true;
          await this.markQuotaFailed(state, now, { code: 'quota_provider_missing', params: { provider } });
          continue;
        }
        const { plan, windows } = usageToQuota(entry, now);
        const quota: QuotaData = { schema: 1, provider, plan, windows, observedAt: now, lastAttemptAt: now, error: null };
        state.snapshot = { ...state.snapshot, quota };
        await state.store.write('quota', quota);
        await this.clearError(state, 'quota');
        this.emit(state, 'quota');
      }
      this.quotaFailures = missing ? this.quotaFailures + 1 : 0;
    } catch (err) {
      this.quotaFailures++;
      for (const state of states) await this.markQuotaFailed(state, now, toErrorInfo(err));
    } finally {
      this.armQuota();
    }
  }

  /** A failed query keeps the previous values, all marked stale */
  private async markQuotaFailed(state: PackState, now: number, error: ErrorInfo): Promise<void> {
    const prev = state.snapshot.quota;
    const quota: QuotaData = {
      schema: 1,
      provider: state.pack.manifest.source.quotaProvider!,
      plan: prev?.plan ?? null,
      windows: (prev?.windows ?? []).map((w) => ({ ...w, stale: true })),
      observedAt: prev?.observedAt ?? null,
      lastAttemptAt: now,
      error,
    };
    state.snapshot = { ...state.snapshot, quota };
    await state.store.write('quota', quota);
    await this.recordError(state, 'quota', new NekoError(error));
    this.emit(state, 'quota');
  }

  private armQuota(): void {
    if (this.stopped || !this.tickTimer) return;
    if (this.quotaTimer) clearTimeout(this.quotaTimer);
    this.quotaTimer = setTimeout(() => void this.refreshQuota(), this.nextQuotaDelay());
  }

  nextQuotaDelay(): number {
    const { quotaBackoffMs, quotaActiveMs, quotaIdleMs } = this.intervals;
    if (this.quotaFailures > 0) {
      return quotaBackoffMs[Math.min(this.quotaFailures, quotaBackoffMs.length) - 1] ?? quotaIdleMs;
    }
    return this.isActive() ? quotaActiveMs : quotaIdleMs;
  }

  private isActive(): boolean {
    const now = this.now();
    return this.active().some((s) => {
      const at = s.snapshot.today?.lastActivityAt;
      return !!at && now - at < this.intervals.activeWindowMs;
    });
  }

  // ---- heartbeat: day change, resume from sleep, quota resets -----------------

  private tick(): void {
    const now = this.now();
    const sleptFor = now - this.lastTickAt;
    this.lastTickAt = now;
    const date = localDate(now);

    if (date !== this.currentDate || sleptFor > this.intervals.tickMs * 3) {
      if (date !== this.currentDate) this.onEvent({ type: 'day_rollover', from: this.currentDate, to: date });
      else this.onEvent({ type: 'resumed', seconds: Math.round(sleptFor / 1000) });
      this.currentDate = date;
      void this.refreshAll();
      return;
    }

    if (now - this.lastTodayScanAt >= this.intervals.todayFallbackMs) {
      void this.refreshToday(this.activeIds());
    }

    // A quota window reached its reset time: mark it stale and query again soon
    let expired = false;
    for (const state of this.active()) {
      const quota = state.snapshot.quota;
      if (!quota?.windows.some((w) => !w.stale && w.resetsAt != null && w.resetsAt <= now)) continue;
      expired = true;
      const next: QuotaData = {
        ...quota,
        windows: quota.windows.map((w) => (w.resetsAt != null && w.resetsAt <= now ? { ...w, stale: true } : w)),
      };
      state.snapshot = { ...state.snapshot, quota: next };
      void state.store.write('quota', next).catch(() => {});
      this.emit(state, 'quota');
    }
    if (expired && this.quotaFailures === 0) void this.refreshQuota();
  }

  // ---- data, status, errors --------------------------------------------------

  private async loadData(): Promise<void> {
    for (const state of this.active()) {
      try {
        const { snapshot, recoveredFrom } = await state.store.load();
        state.snapshot = snapshot;
        state.recoveredFrom = recoveredFrom;
        if (recoveredFrom) this.onEvent({ type: 'history_recovered', packId: state.pack.id, file: recoveredFrom });
      } catch (err) {
        if (!(err instanceof NekoError) || err.code !== 'history_unreadable') throw err;
        // Ledger and backups unreadable: load everything else, never write history
        state.historyBlocked = true;
        state.snapshot = {
          packId: state.pack.id,
          today: await state.store.read('today'),
          history: null,
          quota: await state.store.read('quota'),
          status: await state.store.read('status'),
        };
        await this.recordError(state, 'history', err);
      }
      if (state.snapshot.status) state.warnings = state.snapshot.status.warnings;
      this.emit(state, 'cache');
    }
  }

  private async refreshVersion(): Promise<void> {
    try {
      const result = await this.runner.run({ kind: 'version' });
      this.tokscaleVersion = result.stdout.trim().replace(/^tokscale\s+/i, '') || null;
    } catch (err) {
      this.tokscaleVersion = null;
      for (const state of this.active()) await this.recordError(state, 'version', err);
    }
  }

  private clientsOf(states: PackState[]): string[] {
    return [...new Set(states.flatMap((s) => s.pack.manifest.source.tokscaleClients))];
  }

  private async recordError(state: PackState, stage: Stage, err: unknown, options: { write?: boolean } = {}): Promise<void> {
    const error = toErrorInfo(err);
    state.errors.set(stage, { at: this.now(), error });
    this.onEvent({ type: 'pack_error', packId: state.pack.id, stage, error });
    // A locked pack must not write: its status file belongs to the other process
    if (options.write === false) {
      state.snapshot = { ...state.snapshot, status: this.buildStatus(state) };
      this.emit(state, 'status');
    } else {
      await this.writeStatus(state);
    }
  }

  private async clearError(state: PackState, stage: Stage): Promise<void> {
    if (!state.errors.delete(stage) && state.snapshot.status) return;
    await this.writeStatus(state);
  }

  private buildStatus(state: PackState): StatusData {
    const watch = state.watcher?.getState();
    let lastError: StatusData['lastError'] = null;
    for (const [stage, e] of state.errors) {
      if (!lastError || e.at >= lastError.at) lastError = { at: e.at, stage, ...e.error };
    }
    return {
      schema: 1,
      tokscaleVersion: this.tokscaleVersion,
      watch: watch?.mode ?? 'none',
      watchRoots: watch?.roots ?? state.pack.watchRoots.map((p) => ({ path: p, exists: existsSync(p) })),
      history: { ...historyStats(state.snapshot.history), recoveredFrom: state.recoveredFrom },
      warnings: state.warnings,
      lastError,
      updatedAt: this.now(),
    };
  }

  private async writeStatus(state: PackState): Promise<void> {
    const status = this.buildStatus(state);
    state.snapshot = { ...state.snapshot, status };
    try {
      await state.store.write('status', status);
    } catch {
      // status.json is diagnostics only; failing to write it must not break collection
    }
    this.emit(state, 'status');
  }

  private emit(state: PackState, reason: UpdateReason): void {
    try {
      this.onUpdate?.(state.snapshot, reason);
    } catch {
      // a broken listener must not stop collection
    }
  }
}
