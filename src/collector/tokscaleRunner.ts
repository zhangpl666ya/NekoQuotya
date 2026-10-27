import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { NekoError } from '../shared/errors.ts';
import { proxyEnv } from './proxy.ts';

// The only place in the core that runs tokscale.
//  · Only the requests below are accepted and their arguments are built here, so
//    commands that upload data (login, submit, ...) cannot be constructed at all
//  · Globally serial: one tokscale process at a time; identical queued requests merge
//  · A timeout kills the process and waits until it has really exited

export type TokscaleRequest =
  | { kind: 'version' }
  /** Today's usage, split by session */
  | { kind: 'today'; clients: string[] }
  /** One day's usage, split by session */
  | { kind: 'day'; clients: string[]; date: string }
  | { kind: 'usage' };

export interface TokscaleResult {
  stdout: string;
  /** Hints from stderr (tokscale uses it to report e.g. partially missing data) */
  warnings: string[];
  durationMs: number;
}

export interface Runner {
  run(request: TokscaleRequest): Promise<TokscaleResult>;
  dispose(): Promise<void>;
}

const TIMEOUT_MS: Record<TokscaleRequest['kind'], number> = {
  version: 10_000,
  today: 30_000,
  day: 30_000,
  usage: 20_000,
};
const MAX_STDOUT = 64 * 1024 * 1024;
const MAX_STDERR = 256 * 1024;
const KILL_GRACE_MS = 5_000;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BY_SESSION = 'client,session,model';
const CLIENT = /^[a-z0-9-]+$/;

/** home: make tokscale read session logs from another home folder (testing); local usage only, never quota */
export function buildArgs(request: TokscaleRequest, home?: string): string[] {
  const homeArgs = home ? ['--home', home] : [];
  switch (request.kind) {
    case 'version':
      return ['--version'];
    case 'today':
      return ['--json', '--today', '--client', clientList(request.clients), '--group-by', BY_SESSION, ...homeArgs, '--no-spinner'];
    case 'day':
      if (!DATE.test(request.date)) throw new Error('date must be YYYY-MM-DD');
      return [
        '--json',
        '--since', request.date,
        '--until', request.date,
        '--client', clientList(request.clients),
        '--group-by', BY_SESSION,
        ...homeArgs,
        '--no-spinner',
      ];
    case 'usage':
      return ['usage', '--json'];
  }
}

function clientList(clients: string[]): string {
  if (!clients.length) throw new Error('at least one client is required');
  for (const c of clients) if (!CLIENT.test(c)) throw new Error(`invalid client id: ${c}`);
  return [...new Set(clients)].sort().join(',');
}

const PLATFORM_PACKAGES: Record<string, string> = {
  'win32-x64': '@tokscale/cli-win32-x64-msvc',
  'win32-arm64': '@tokscale/cli-win32-arm64-msvc',
  'darwin-arm64': '@tokscale/cli-darwin-arm64',
  'darwin-x64': '@tokscale/cli-darwin-x64',
  'linux-x64': '@tokscale/cli-linux-x64-gnu',
  'linux-arm64': '@tokscale/cli-linux-arm64-gnu',
};

/**
 * Locate the tokscale executable, in order:
 *  1. the NEKO_TOKSCALE_PATH environment variable
 *  2. resources/bin/ in a packaged app
 *  3. the @tokscale/cli-* package for this platform in node_modules
 */
export function resolveTokscaleBinary(): string | null {
  const exe = process.platform === 'win32' ? 'tokscale.exe' : 'tokscale';

  const override = process.env.NEKO_TOKSCALE_PATH;
  if (override) return existsSync(override) ? override : null;

  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, 'bin', exe);
    if (existsSync(packaged)) return packaged;
  }

  const pkg = PLATFORM_PACKAGES[`${process.platform}-${process.arch}`];
  if (!pkg) return null;
  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve(`${pkg}/package.json`);
    const candidate = path.join(path.dirname(pkgJson), 'bin', exe);
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export class TokscaleRunner implements Runner {
  private readonly binary: string | null;
  private readonly home: string | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  /** Requests queued but not yet started, used to merge duplicates */
  private readonly pending = new Map<string, Promise<TokscaleResult>>();
  private current: ChildProcess | null = null;
  private disposed = false;

  constructor(binary: string | null = resolveTokscaleBinary(), options: { home?: string } = {}) {
    this.binary = binary;
    this.home = options.home;
  }

  run(request: TokscaleRequest): Promise<TokscaleResult> {
    if (this.disposed) return Promise.reject(new NekoError({ code: 'tokscale_stopped' }));
    const args = buildArgs(request, this.home);
    const key = args.join('\u0000');
    const queued = this.pending.get(key);
    if (queued) return queued;

    const job = this.tail.then(() => {
      this.pending.delete(key);
      return this.exec(args, TIMEOUT_MS[request.kind]);
    });
    this.pending.set(key, job);
    this.tail = job.catch(() => {});
    return job;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.current?.kill();
    await this.tail;
  }

  private async exec(args: string[], timeoutMs: number): Promise<TokscaleResult> {
    if (this.disposed) throw new NekoError({ code: 'tokscale_stopped' });
    const binary = this.binary;
    if (!binary) throw new NekoError({ code: 'tokscale_not_found' });
    const extraEnv = await proxyEnv();
    const started = Date.now();

    return new Promise<TokscaleResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(binary, args, {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ...extraEnv, NO_COLOR: '1' },
        });
      } catch (err) {
        reject(new NekoError({ code: 'tokscale_spawn_failed', detail: (err as Error).message }));
        return;
      }
      this.current = child;
      lowerPriority(child.pid);

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let overflow = false;
      child.stdout!.setEncoding('utf8');
      child.stderr!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        if (stdout.length + chunk.length > MAX_STDOUT) {
          overflow = true;
          child.kill();
          return;
        }
        stdout += chunk;
      });
      child.stderr!.on('data', (chunk: string) => {
        if (stderr.length < MAX_STDERR) stderr += chunk;
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
        // Force it if a normal kill does not end the process; 'close' stays the only end signal
        setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
      }, timeoutMs);

      child.once('error', (err) => {
        clearTimeout(timer);
        this.current = null;
        reject(new NekoError({ code: 'tokscale_spawn_failed', detail: err.message }));
      });

      child.once('close', (code) => {
        clearTimeout(timer);
        this.current = null;
        const tail = stderr.trim().split(/\r?\n/).slice(-3).join(' ') || undefined;
        if (timedOut) {
          reject(new NekoError({ code: 'tokscale_timeout', params: { seconds: timeoutMs / 1000 }, detail: tail }));
        } else if (overflow) {
          reject(new NekoError({ code: 'tokscale_output_too_large' }));
        } else if (code !== 0) {
          reject(new NekoError({ code: 'tokscale_exit', params: { exitCode: String(code) }, detail: tail }));
        } else {
          resolve({ stdout, warnings: parseWarnings(stderr), durationMs: Date.now() - started });
        }
      });
    });
  }
}

export function parseWarnings(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(warning:|tokscale:)/i.test(line))
    .map((line) => line.replace(/^warning:\s*/i, '').replace(/^tokscale:\s*/i, ''));
}

/** Scans are CPU-heavy; on Windows lower them to "below normal" so foreground apps stay responsive */
function lowerPriority(pid: number | undefined): void {
  if (!pid || process.platform !== 'win32') return;
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // best effort
  }
}
