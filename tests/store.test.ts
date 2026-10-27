import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DataLock, STALE_MS } from '../src/collector/dataLock.ts';
import { BACKUP_KEEP, PackStore } from '../src/collector/packStore.ts';
import { NekoError } from '../src/shared/errors.ts';
import { emptyHistory } from '../src/shared/ledger.ts';
import type { HistoryData } from '../src/shared/types.ts';

const tmpDir = () => mkdtempSync(path.join(os.tmpdir(), 'neko-store-'));
const dayAt = (d: number) => new Date(2026, 9, d, 12).getTime();
const ledger = (marker: number): HistoryData => ({ ...emptyHistory(0), updatedAt: marker });

// ---- ledger backups ------------------------------------------------------------

test('backups: the ledger is copied once per day before writing; only the newest 7 are kept', async () => {
  const dir = tmpDir();
  let clock = dayAt(1);
  const store = new PackStore('claude', dir, () => clock);
  await store.write('history', ledger(1)); // no ledger yet: nothing to back up

  for (let d = 2; d <= 10; d++) {
    clock = dayAt(d);
    const dayStore = new PackStore('claude', dir, () => clock); // a new run each day
    await dayStore.write('history', ledger(d));
    await dayStore.write('history', ledger(d + 0.5)); // a second write the same day makes no new backup
  }
  const backups = await store.listBackups();
  assert.equal(backups.length, BACKUP_KEEP);
  assert.equal(backups[0], 'history-2026-10-10.json');
  assert.equal(backups.at(-1), 'history-2026-10-04.json');
  // Each backup holds the ledger as it was at the end of the previous day
  const newest = JSON.parse(readFileSync(path.join(dir, 'backups', backups[0]!), 'utf8'));
  assert.equal(newest.updatedAt, 9.5);
});

test('recovery: a damaged ledger is restored from the newest readable backup; the damaged file is kept', async () => {
  const dir = tmpDir();
  mkdirSync(path.join(dir, 'backups'));
  writeFileSync(path.join(dir, 'backups', 'history-2026-10-09.json'), JSON.stringify(ledger(9)));
  writeFileSync(path.join(dir, 'backups', 'history-2026-10-10.json'), '{ damaged too');
  writeFileSync(path.join(dir, 'history.json'), '{ damaged');

  const { snapshot, recoveredFrom } = await new PackStore('claude', dir).load();
  assert.equal(recoveredFrom, 'history-2026-10-09.json');
  assert.equal(snapshot.history!.updatedAt, 9);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'history.json'), 'utf8')).updatedAt, 9);
  const kept = readdirSync(dir).filter((n) => n.startsWith('history.corrupt-'));
  assert.equal(kept.length, 1);
  assert.equal(readFileSync(path.join(dir, kept[0]!), 'utf8'), '{ damaged');
});

test('recovery: without a readable backup, loading fails with history_unreadable and nothing is overwritten', async () => {
  const dir = tmpDir();
  writeFileSync(path.join(dir, 'history.json'), '{ damaged');
  await assert.rejects(new PackStore('claude', dir).load(), (err) => err instanceof NekoError && err.code === 'history_unreadable');
  assert.equal(readFileSync(path.join(dir, 'history.json'), 'utf8'), '{ damaged');
});

test('a missing ledger is simply empty', async () => {
  const { snapshot, recoveredFrom } = await new PackStore('claude', tmpDir()).load();
  assert.equal(snapshot.history, null);
  assert.equal(recoveredFrom, null);
});

// ---- data folder lock ----------------------------------------------------------

test('lock: acquire creates the lock file and release removes it', async () => {
  const dir = tmpDir();
  const a = new DataLock(dir);
  await a.acquire();
  assert.ok(existsSync(path.join(dir, '.lock')));
  await a.release();
  assert.ok(!existsSync(path.join(dir, '.lock')));
});

test('lock: refused while another live process holds it; taken over once that process exits', async () => {
  const dir = tmpDir();
  // A child process that writes a lock with its own PID and stays alive
  const child = spawn(process.execPath, [
    '-e',
    `require('fs').writeFileSync(${JSON.stringify(path.join(dir, '.lock'))}, JSON.stringify({pid: process.pid, host: require('os').hostname(), startedAt: Date.now()})); setInterval(() => {}, 1000);`,
  ]);
  try {
    await new Promise((r) => setTimeout(r, 500));
    await assert.rejects(new DataLock(dir).acquire(), (err) => err instanceof NekoError && err.code === 'data_locked' && err.params?.pid === child.pid);
  } finally {
    child.kill();
    await new Promise((r) => child.once('exit', r));
  }
  const lock = new DataLock(dir);
  await lock.acquire(); // owner is gone: stale, taken over
  await lock.release();
});

test('lock: a lock whose heartbeat stopped is stale even if its PID is in use (recycled PID)', async () => {
  const dir = tmpDir();
  // Pretend PID 4 (always alive on Windows: "System"; on POSIX use our parent) holds it, with an old heartbeat
  const livePid = process.platform === 'win32' ? 4 : process.ppid;
  const file = path.join(dir, '.lock');
  writeFileSync(file, JSON.stringify({ pid: livePid, host: os.hostname(), startedAt: 0 }));
  const old = new Date(Date.now() - STALE_MS - 60_000);
  utimesSync(file, old, old);
  const lock = new DataLock(dir);
  await lock.acquire();
  await lock.release();
});
