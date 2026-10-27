import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NekoError } from '../shared/errors.ts';

// One writer per data/ folder. Electron's single-instance lock only stops a second
// copy of the same app; this also covers a dev collector running next to the app,
// or an installed and a portable copy pointing at the same folder.
//
// data/.lock holds the owner's PID. The owner refreshes the file's mtime every
// HEARTBEAT_MS. A lock counts as stale (and is taken over) when its PID is gone
// or its heartbeat is older than STALE_MS, which also covers a recycled PID.

export const HEARTBEAT_MS = 30_000;
export const STALE_MS = 2 * 60_000;
const FILE = '.lock';

interface LockInfo {
  pid: number;
  host: string;
  startedAt: number;
}

export class DataLock {
  readonly dataDir: string;
  private timer: NodeJS.Timeout | null = null;
  private held = false;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  private get file(): string {
    return path.join(this.dataDir, FILE);
  }

  /** Throws data_locked if another live process holds the folder */
  async acquire(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    const info: LockInfo = { pid: process.pid, host: os.hostname(), startedAt: Date.now() };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await fs.writeFile(this.file, JSON.stringify(info), { flag: 'wx' });
        this.held = true;
        this.timer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
        this.timer.unref();
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const owner = await this.readOwner();
      if (owner && owner.pid !== process.pid && !(await this.isStale(owner))) {
        throw new NekoError({ code: 'data_locked', params: { pid: owner.pid } });
      }
      await fs.rm(this.file, { force: true }); // stale or our own leftover: take over
    }
    throw new NekoError({ code: 'data_locked', params: { pid: '?' } });
  }

  async release(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.held) return;
    this.held = false;
    const owner = await this.readOwner();
    if (owner?.pid === process.pid) await fs.rm(this.file, { force: true });
  }

  private async heartbeat(): Promise<void> {
    const now = new Date();
    await fs.utimes(this.file, now, now).catch(() => {});
  }

  private async readOwner(): Promise<LockInfo | null> {
    try {
      return JSON.parse(await fs.readFile(this.file, 'utf8')) as LockInfo;
    } catch {
      return null;
    }
  }

  private async isStale(owner: LockInfo): Promise<boolean> {
    // Another machine's PID cannot be checked (e.g. a shared network folder); rely on the heartbeat alone
    if (owner.host === os.hostname() && !isAlive(owner.pid)) return true;
    try {
      const { mtimeMs } = await fs.stat(this.file);
      return Date.now() - mtimeMs > STALE_MS;
    } catch {
      return true;
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
