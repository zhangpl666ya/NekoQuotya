import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyBehaviorOverride, expandPath, packName, resolveInsidePack, PackManifestSchema } from '../src/shared/packs/manifest.ts';
import { loadPacks } from '../src/shared/packs/registry.ts';

const HOME = path.resolve('/home/neko');

test('path expansion: env var first, then default; ~ is the home folder', () => {
  assert.equal(expandPath('${CLAUDE_CONFIG_DIR|~/.claude}/projects', {}, HOME), path.join(HOME, '.claude', 'projects'));
  assert.equal(
    expandPath('${CLAUDE_CONFIG_DIR|~/.claude}/projects', { CLAUDE_CONFIG_DIR: path.resolve('/cfg') }, HOME),
    path.join(path.resolve('/cfg'), 'projects')
  );
  assert.equal(expandPath('~', {}, HOME), path.normalize(HOME));
});

test('paths inside a pack cannot escape it', () => {
  const dir = path.resolve('/packs/claude');
  assert.equal(resolveInsidePack(dir, 'appearance/a.json'), path.join(dir, 'appearance', 'a.json'));
  assert.equal(resolveInsidePack(dir, '../codex/pack.json'), null);
  assert.equal(resolveInsidePack(dir, path.resolve('/etc/passwd')), null);
  assert.equal(resolveInsidePack(dir, '.'), null);
});

function makePacksRoot(packs: Record<string, unknown>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'neko-packs-'));
  for (const [dir, manifest] of Object.entries(packs)) {
    mkdirSync(path.join(root, dir));
    if (manifest !== undefined) {
      writeFileSync(path.join(root, dir, 'pack.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
    }
  }
  return root;
}

const valid = {
  id: 'claude',
  name: 'Claude-chan',
  version: 1,
  packFormat: 1,
  source: { tokscaleClients: ['claude'], quotaProvider: 'Claude', watch: [{ path: '~/.claude/projects' }] },
};

test('a valid pack loads with defaults filled in', async () => {
  const root = makePacksRoot({ claude: valid });
  const { packs, errors } = await loadPacks(root, { env: {}, home: HOME });
  assert.deepEqual(errors, []);
  assert.equal(packs.length, 1);
  const pack = packs[0]!;
  assert.equal(pack.dataDir, path.join(root, 'claude', 'data'));
  assert.deepEqual(pack.watchRoots, [path.join(HOME, '.claude', 'projects')]);
  assert.equal(pack.manifest.behavior.dailyBudget, 2_000_000);
  assert.equal(pack.manifest.source.lateArrivalDays, 0);
  assert.equal(pack.manifest.appearance.renderer, 'placeholder');
});

test('invalid packs are skipped with an error code; other packs still load', async () => {
  const root = makePacksRoot({
    claude: valid,
    broken: '{ not json',
    empty: undefined,
    mismatch: { ...valid, id: 'other', source: { tokscaleClients: ['other'] } },
    escape: { ...valid, id: 'escape', source: { tokscaleClients: ['x'] }, appearance: { renderer: 'image', entry: '../x.json' } },
    noclient: { ...valid, id: 'noclient', source: { tokscaleClients: [] } },
  });
  const { packs, errors } = await loadPacks(root, { env: {}, home: HOME });
  assert.deepEqual(packs.map((p) => p.id), ['claude']);
  const codes = Object.fromEntries(errors.map((e) => [path.basename(e.dir), e.error.code]));
  assert.deepEqual(codes, {
    broken: 'manifest_invalid_json',
    empty: 'manifest_missing',
    escape: 'manifest_entry_outside_pack',
    mismatch: 'manifest_id_mismatch',
    noclient: 'manifest_invalid',
  });
});

test('a client can belong to only one pack; the later pack is rejected', async () => {
  const root = makePacksRoot({
    'a-claude': { ...valid, id: 'a-claude' },
    'b-claude-too': { ...valid, id: 'b-claude-too', source: { tokscaleClients: ['cherrystudio', 'claude'] } },
  });
  const { packs, errors } = await loadPacks(root, { env: {}, home: HOME });
  assert.deepEqual(packs.map((p) => p.id), ['a-claude']);
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0]!.error, { code: 'client_already_claimed', params: { client: 'claude', owner: 'a-claude' } });
});

test('pack names: a plain string or a per-locale map with English fallback', () => {
  const localized = PackManifestSchema.parse({ ...valid, name: { en: 'Claude-chan', 'zh-CN': 'Claude 娘' } });
  assert.equal(packName(localized, 'zh-CN'), 'Claude 娘');
  assert.equal(packName(localized, 'ja'), 'Claude-chan');
  assert.equal(packName(PackManifestSchema.parse(valid), 'zh-CN'), 'Claude-chan');
});

test('theme: a brand colour with an optional gradient; neutral gray by default', () => {
  assert.deepEqual(PackManifestSchema.parse(valid).theme, { color: '#5f5e5a' });
  const gemini = PackManifestSchema.parse({ ...valid, theme: { color: '#4285F4', gradient: ['#4285F4', '#9B72CB', '#D96570'] } });
  assert.deepEqual(gemini.theme.gradient, ['#4285F4', '#9B72CB', '#D96570']);
  assert.throws(() => PackManifestSchema.parse({ ...valid, theme: { color: 'orange' } }));
  assert.throws(() => PackManifestSchema.parse({ ...valid, theme: { color: '#000000', gradient: ['#000000'] } }));
});

test('card art must live inside the pack’s appearance folder', async () => {
  const root = makePacksRoot({
    ok: { ...valid, id: 'ok', source: { tokscaleClients: ['a'] }, appearance: { renderer: 'placeholder', card: 'appearance/card.png' } },
    outside: { ...valid, id: 'outside', source: { tokscaleClients: ['b'] }, appearance: { renderer: 'placeholder', card: 'lines/card.png' } },
  });
  const { packs, errors } = await loadPacks(root, { env: {}, home: HOME });
  assert.deepEqual(packs.map((p) => p.id), ['ok']);
  assert.equal(errors[0]!.error.code, 'manifest_entry_outside_pack');
});

test('behavior overrides: editable keys only, invalid values fall back to the pack', () => {
  const base = PackManifestSchema.parse(valid).behavior;
  const applied = applyBehaviorOverride(base, {
    dailyBudget: 500_000,
    chatterMinutes: null,
    idleSleepMinutes: -5, // invalid → keep the pack's value
    bubbleSeconds: 99, // not editable → ignored
  });
  assert.equal(applied.dailyBudget, 500_000);
  assert.equal(applied.chatterMinutes, null);
  assert.equal(applied.idleSleepMinutes, base.idleSleepMinutes);
  assert.equal(applied.bubbleSeconds, base.bubbleSeconds);
  assert.deepEqual(applyBehaviorOverride(base, 'garbage'), base);
});

test('the bundled Claude pack is valid', async () => {
  const root = path.resolve(import.meta.dirname, '..', 'packs');
  const { packs, errors } = await loadPacks(root, { env: {}, home: HOME });
  assert.deepEqual(errors, []);
  const claude = packs.find((p) => p.id === 'claude');
  assert.ok(claude);
  assert.deepEqual(claude.manifest.source.tokscaleClients, ['claude']);
  assert.equal(claude.manifest.source.quotaProvider, 'Claude');
});
