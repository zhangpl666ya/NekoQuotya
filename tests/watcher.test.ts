import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseProxyServer } from '../src/collector/proxy.ts';
import { SourceWatcher, isRelevant } from '../src/collector/sourceWatcher.ts';

test('only session logs and database files are relevant', () => {
  assert.equal(isRelevant('a/b/session.jsonl'), true);
  assert.equal(isRelevant('rollout.jsonl.zst'), true);
  assert.equal(isRelevant('state.db-wal'), true);
  assert.equal(isRelevant('state.db-shm'), false);
  assert.equal(isRelevant('notes.txt'), false);
});

test('real folder: a burst of changes fires once after the debounce', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'neko-watch-'));
  const file = path.join(dir, 'session.jsonl');
  writeFileSync(file, '{}\n');

  const fired: string[] = [];
  const watcher = new SourceWatcher({ packId: 'claude', roots: [dir] }, (id) => fired.push(id), {
    debounceMs: 200,
    maxWaitMs: 1_000,
  });
  assert.equal(watcher.start().mode, 'native');
  await sleep(300); // let the watcher get ready

  for (let i = 0; i < 5; i++) {
    appendFileSync(file, '{"x":1}\n');
    await sleep(20);
  }
  appendFileSync(path.join(dir, 'ignored.txt'), 'x');
  await sleep(800);
  await watcher.close();

  assert.deepEqual(fired, ['claude']);
});

test('no existing folder: falls back to polling', async () => {
  const fired: string[] = [];
  const watcher = new SourceWatcher(
    { packId: 'claude', roots: [path.join(os.tmpdir(), 'neko-does-not-exist-' + Date.now())] },
    (id) => fired.push(id),
    { pollMs: 100 }
  );
  const state = watcher.start();
  assert.equal(state.mode, 'polling');
  assert.equal(state.roots[0]!.exists, false);
  await sleep(250);
  await watcher.close();
  assert.ok(fired.length >= 2);
});

test('Windows proxy setting parsing', () => {
  assert.equal(parseProxyServer('127.0.0.1:7897'), 'http://127.0.0.1:7897');
  assert.equal(parseProxyServer('http=127.0.0.1:8080;https=127.0.0.1:8443'), 'http://127.0.0.1:8443');
  assert.equal(parseProxyServer('socks5://127.0.0.1:1080'), 'socks5://127.0.0.1:1080');
  assert.equal(parseProxyServer(''), null);
});
