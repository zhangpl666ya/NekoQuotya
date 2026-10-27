import { existsSync } from 'node:fs';
import { watch, type FSWatcher } from 'chokidar';
import type { WatchMode } from '../shared/types.ts';

// Watches the log folders a pack declares. It only signals "time to scan"; it never
// reads log contents.
//  · Only session logs and database files matter; SQLite -shm index files are
//    rewritten by reads, so they are ignored
//  · Debounce: fires 3 s after changes stop; under continuous writes (a model is
//    streaming) it fires at most every 10 s
//  · If no folder exists, or watching fails, it falls back to a signal every 60 s

const RELEVANT = /\.(jsonl|jsonl\.zst|zst|json|db|sqlite|db-wal|sqlite-wal)$/i;

export interface WatchTarget {
  packId: string;
  roots: string[];
}

export interface WatcherOptions {
  debounceMs?: number;
  maxWaitMs?: number;
  pollMs?: number;
  /** Injected in tests; chokidar by default */
  createWatcher?: (roots: string[]) => FSWatcher;
}

export interface WatchState {
  mode: WatchMode;
  roots: Array<{ path: string; exists: boolean }>;
}

export class SourceWatcher {
  private readonly target: WatchTarget;
  private readonly onChange: (packId: string) => void;
  private readonly opts: Required<Omit<WatcherOptions, 'createWatcher'>>;
  private readonly createWatcher: (roots: string[]) => FSWatcher;
  private watcher: FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private firstEventAt: number | null = null;
  private state: WatchState;
  private closed = false;

  constructor(target: WatchTarget, onChange: (packId: string) => void, options: WatcherOptions = {}) {
    this.target = target;
    this.onChange = onChange;
    this.opts = {
      debounceMs: options.debounceMs ?? 3_000,
      maxWaitMs: options.maxWaitMs ?? 10_000,
      pollMs: options.pollMs ?? 60_000,
    };
    this.createWatcher = options.createWatcher ?? defaultWatcher;
    this.state = { mode: 'none', roots: [] };
  }

  start(): WatchState {
    const roots = this.target.roots.map((p) => ({ path: p, exists: existsSync(p) }));
    const existing = roots.filter((r) => r.exists).map((r) => r.path);
    this.state = { mode: 'none', roots };

    if (!existing.length) {
      this.startPolling();
      return this.state;
    }
    try {
      this.watcher = this.createWatcher(existing);
      this.watcher.on('all', (_event, file) => {
        if (typeof file === 'string' && isRelevant(file)) this.schedule();
      });
      this.watcher.on('error', () => this.fallbackToPolling());
      this.state.mode = 'native';
    } catch {
      this.fallbackToPolling();
    }
    return this.state;
  }

  getState(): WatchState {
    return this.state;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.debounceTimer = null;
    this.pollTimer = null;
    const w = this.watcher;
    this.watcher = null;
    await w?.close();
  }

  private schedule(): void {
    if (this.closed) return;
    const now = Date.now();
    this.firstEventAt ??= now;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    const waited = now - this.firstEventAt;
    const delay = Math.max(0, Math.min(this.opts.debounceMs, this.opts.maxWaitMs - waited));
    this.debounceTimer = setTimeout(() => this.fire(), delay);
  }

  private fire(): void {
    this.debounceTimer = null;
    this.firstEventAt = null;
    if (!this.closed) this.onChange(this.target.packId);
  }

  private fallbackToPolling(): void {
    if (this.closed || this.state.mode === 'polling') return;
    const w = this.watcher;
    this.watcher = null;
    void w?.close().catch(() => {});
    this.startPolling();
  }

  private startPolling(): void {
    this.state.mode = 'polling';
    this.pollTimer = setInterval(() => this.fire(), this.opts.pollMs);
  }
}

export function isRelevant(file: string): boolean {
  if (/-shm$/i.test(file)) return false;
  return RELEVANT.test(file);
}

function defaultWatcher(roots: string[]): FSWatcher {
  return watch(roots, {
    ignoreInitial: true,
    persistent: true,
    depth: 8,
    // Filter files only; folders must pass so sessions created later are discovered
    ignored: (file, stats) => !!stats?.isFile() && !isRelevant(file),
  });
}
