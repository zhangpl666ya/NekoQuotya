import path from 'node:path';
import { parseArgs } from 'node:util';
import { describeError, isLocale, translator, type Locale } from '../shared/i18n/index.ts';
import { summarizeDays } from '../shared/ledger.ts';
import { packName } from '../shared/packs/manifest.ts';
import { loadPacks } from '../shared/packs/registry.ts';
import type { PackSnapshot, QuotaWindow } from '../shared/types.ts';
import { activeTokens, localDate, shiftDate } from '../shared/usage.ts';
import type { PetIntent } from '../shared/pet.ts';
import { PetBrain } from '../main/brain/petBrain.ts';
import { Scheduler, type SchedulerEvent, type UpdateReason } from './scheduler.ts';
import { TokscaleRunner, resolveTokscaleBinary } from './tokscaleRunner.ts';

// Developer harness for the data layer; the shipped app has no terminal and drives
// the same Scheduler from its UI.
//   npm run collect          keep running: auto refresh; type r / s / q + Enter
//   npm run collect:once     one pass of today, history catch-up and quota, then exit
//   npm run collect:resync   re-verify all history, then exit
//   npm run pet              keep running and print the pet's reactions (p + Enter pokes her)
// Options: --lang en|zh-CN, --packs <dir>, --home <dir> (read logs from another home; testing)

const { values } = parseArgs({
  options: {
    once: { type: 'boolean', default: false },
    resync: { type: 'boolean', default: false },
    pet: { type: 'boolean', default: false },
    packs: { type: 'string' },
    home: { type: 'string' },
    lang: { type: 'string', default: 'en' },
  },
});

const locale: Locale = isLocale(values.lang) ? values.lang : 'en';
const t = translator(locale);

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const packsRoot = path.resolve(values.packs ?? path.join(projectRoot, 'packs'));

const binary = resolveTokscaleBinary();
if (!binary) {
  console.error(describeError(t, { code: 'tokscale_not_found' }));
  process.exit(1);
}

const { packs, errors } = await loadPacks(packsRoot);
for (const e of errors) console.warn(t('cli.packSkipped', { dir: e.dir, reason: describeError(t, e.error) }));
if (!packs.length) {
  console.error(t('cli.noPacks', { dir: packsRoot }));
  process.exit(1);
}
console.log(t('cli.tokscale', { path: binary }));
console.log(t('cli.packs', { list: packs.map((p) => `${p.id} (${packName(p.manifest, locale)})`).join(', ') }));

const oneShot = values.once || values.resync;

// Pet mode: one brain per pack, fed with every update and ticked every second
const brains = new Map<string, { brain: PetBrain; last: string }>();
if (values.pet && !oneShot) {
  for (const p of packs) brains.set(p.id, { brain: new PetBrain(p.manifest.behavior, Date.now()), last: '' });
  setInterval(() => {
    for (const [id, b] of brains) showPet(id, b.brain.tick(Date.now()));
  }, 1000).unref();
}

const scheduler = new Scheduler({
  packs,
  runner: new TokscaleRunner(binary, { home: values.home }),
  watch: !oneShot,
  onUpdate: (snap, reason) => {
    const line = describeUpdate(snap, reason);
    if (line) console.log(`${clock()} [${snap.packId}] ${line}`);
    const pet = brains.get(snap.packId);
    if (pet) showPet(snap.packId, pet.brain.observe(snap, Date.now()));
  },
  onEvent: (event) => console.log(`${clock()} ${describeEvent(event)}`),
});

if (oneShot) {
  await scheduler.runOnce({ resync: values.resync });
  await scheduler.stop();
  for (const p of packs) {
    const snap = scheduler.snapshot(p.id)!;
    console.log(`\n${t('cli.written', { name: packName(p.manifest, locale), dir: p.dataDir })}`);
    console.log(summary(snap));
    for (const w of snap.status?.warnings ?? []) console.log(`  ${t('cli.hint', { text: w })}`);
  }
} else {
  await scheduler.start();
  for (const p of packs) {
    const st = scheduler.snapshot(p.id)?.status;
    const roots = st?.watchRoots.filter((r) => r.exists).map((r) => r.path) ?? [];
    console.log(`${clock()} [${p.id}] ${t('cli.watching', { mode: st?.watch ?? 'none', roots: roots.length ? ` — ${roots.join('; ')}` : '' })}`);
  }
  console.log(`${clock()} ${t('cli.running')}`);
  if (brains.size) console.log(`${clock()} ${t('cli.petHint')}`);
  const shutdown = async () => {
    console.log(`\n${clock()} ${t('cli.stopping')}`);
    await scheduler.stop();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  // Manual refresh; the app's buttons call the same methods
  let busy = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (input: string) => {
    const cmd = input.trim().toLowerCase();
    if (cmd === 'q') return void shutdown();
    if (cmd === 'p') {
      for (const [id, b] of brains) showPet(id, b.brain.interact('poke', Date.now()));
      return;
    }
    if (cmd !== 'r' && cmd !== 's') return;
    if (busy) return console.log(`${clock()} ${t('cli.busy')}`);
    busy = true;
    const started = Date.now();
    console.log(`${clock()} ${t(cmd === 'r' ? 'cli.refreshing' : 'cli.resyncing')}`);
    try {
      await (cmd === 'r' ? scheduler.refreshNow() : scheduler.resyncAll());
      console.log(`${clock()} ${t('cli.done', { seconds: ((Date.now() - started) / 1000).toFixed(1) })}`);
    } finally {
      busy = false;
    }
  });
}

/** Print the pet's state when its mood, activity, action or bubble changes */
function showPet(packId: string, intent: PetIntent): void {
  const pet = brains.get(packId);
  if (!pet) return;
  const key = [intent.mood, intent.activity, intent.action?.id, intent.action?.startedAt, intent.bubble?.id].join('|');
  if (key === pet.last) return;
  pet.last = key;
  const line = t('cli.pet', {
    mood: intent.mood,
    activity: intent.activity,
    action: intent.action ? ` · ${intent.action.id}` : '',
    bubble: intent.bubble ? ` · 💬 ${intent.bubble.lineKey}` : '',
  });
  const info = `${intent.info.basis} ${intent.info.pressure}%${intent.info.stale ? ' ?' : ''}`;
  console.log(`${clock()} [${packId}] ${line}  (${info})`);
}

function describeUpdate(snap: PackSnapshot, reason: UpdateReason): string | null {
  switch (reason) {
    case 'today': {
      const s = snap.today!;
      return t('cli.today', {
        active: fmt(activeTokens(s.total)),
        input: fmt(s.total.input),
        output: fmt(s.total.output),
        cacheRead: fmt(s.total.cacheRead),
        messages: s.total.messages,
        sessions: Object.keys(s.sessions).length,
      });
    }
    case 'history':
      return historyLine(snap);
    case 'quota':
      return quotaLine(snap);
    case 'status': {
      const e = snap.status?.lastError;
      return e ? t('cli.error', { stage: t(`stage.${e.stage}`), message: describeError(t, e) }) : null;
    }
    case 'cache':
      return snap.today || snap.history ? t('cli.cache') : null;
  }
}

function describeEvent(e: SchedulerEvent): string {
  switch (e.type) {
    case 'day_rollover':
      return t('cli.dayRollover', { from: e.from, to: e.to });
    case 'resumed':
      return t('cli.resumed', { seconds: e.seconds });
    case 'history_backfill':
      return t('cli.backfill', { from: e.from, to: e.to, count: e.count });
    case 'version_changed':
      return `[${e.packId}] ${t('cli.versionChanged', { from: e.from, to: e.to })}`;
    case 'sessions_renamed':
      return `[${e.packId}] ${t('cli.renamed', { date: e.date, count: e.count })}`;
    case 'history_recovered':
      return `[${e.packId}] ${t('cli.recovered', { file: e.file })}`;
    case 'day_failed':
      return t('cli.dayFailed', { date: e.date, message: describeError(t, e.error) });
    case 'pack_error':
      return `[${e.packId}] ${t('cli.error', { stage: t(`stage.${e.stage}`), message: describeError(t, e.error) })}`;
  }
}

function historyLine(snap: PackSnapshot): string | null {
  const s = snap.status?.history;
  if (!s) return null;
  return t('cli.history', { days: s.days, sessions: s.sessions, retained: s.retainedSessions, through: s.verifiedThrough ?? '—' });
}

function quotaLine(snap: PackSnapshot): string {
  const q = snap.quota;
  if (!q) return t('quota.none');
  const windows = q.windows.filter((w) => w.applicable).map(windowText).join(' · ');
  const error = q.error ? ` ⚠ ${describeError(t, q.error)}` : '';
  return `${q.plan ?? ''} ${windows}${error}`.trim();
}

function windowText(w: QuotaWindow): string {
  const label = w.kind === 'other' ? w.rawLabel : t(`quota.${w.kind}`);
  const reset = w.resetsAt ? ` (${t('quota.resets', { time: resetText(w.resetsAt) })})` : '';
  const stale = w.stale ? ` [${t('quota.stale')}]` : '';
  return `${label} ${w.usedPercent ?? '?'}%${reset}${stale}`;
}

function summary(snap: PackSnapshot): string {
  const today = localDate(Date.now());
  const past = summarizeDays(snap.history, shiftDate(today, -6), shiftDate(today, -1));
  const todayTokens = snap.today?.date === today ? activeTokens(snap.today.total) : 0;
  const week = past.reduce((sum, d) => sum + activeTokens(d.total), 0) + todayTokens;
  return [`  ${t('cli.summary', { today: fmt(todayTokens), week: fmt(week) })}`, `  ${historyLine(snap) ?? ''}`, `  ${quotaLine(snap)}`]
    .filter((line) => line.trim())
    .join('\n');
}

function fmt(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function clock(ts = Date.now()): string {
  return new Date(ts).toLocaleTimeString(locale, { hour12: false });
}

function resetText(ts: number): string {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false })
    : d.toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}
