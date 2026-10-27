import fs from 'node:fs/promises';
import path from 'node:path';
import type { ErrorInfo } from '../errors.ts';
import { PackManifestSchema, expandPath, resolveInsidePack, type PackManifest } from './manifest.ts';

export interface LoadedPack {
  id: string;
  dir: string;
  dataDir: string;
  manifest: PackManifest;
  /** Expanded absolute paths, de-duplicated */
  watchRoots: string[];
}

export interface PackLoadError {
  dir: string;
  error: ErrorInfo;
}

export interface PackRegistryResult {
  packs: LoadedPack[];
  errors: PackLoadError[];
}

interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/**
 * Scan the packs folder, reading and validating every pack. Invalid packs are
 * skipped with a reason. Packs load in folder-name order; a pack that claims a
 * tokscale client already claimed by an earlier pack is rejected, because both
 * would receive the same usage and any cross-pack total would count it twice.
 */
export async function loadPacks(packsRoot: string, options: LoadOptions = {}): Promise<PackRegistryResult> {
  const packs: LoadedPack[] = [];
  const errors: PackLoadError[] = [];

  let entries;
  try {
    entries = await fs.readdir(packsRoot, { withFileTypes: true });
  } catch (err) {
    return { packs, errors: [{ dir: packsRoot, error: { code: 'packs_dir_unreadable', detail: errMessage(err) } }] };
  }

  const owners = new Map<string, string>();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(packsRoot, entry.name);
    const result = await loadPack(dir, options);
    if ('error' in result) {
      errors.push({ dir, error: result.error });
      continue;
    }
    const pack = result.pack;
    const taken = pack.manifest.source.tokscaleClients.find((c) => owners.has(c));
    if (taken) {
      errors.push({ dir, error: { code: 'client_already_claimed', params: { client: taken, owner: owners.get(taken)! } } });
      continue;
    }
    for (const c of pack.manifest.source.tokscaleClients) owners.set(c, pack.id);
    packs.push(pack);
  }
  return { packs, errors };
}

export async function loadPack(dir: string, options: LoadOptions = {}): Promise<{ pack: LoadedPack } | { error: ErrorInfo }> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, 'pack.json'), 'utf8');
  } catch {
    return { error: { code: 'manifest_missing' } };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { error: { code: 'manifest_invalid_json', detail: errMessage(err) } };
  }

  const parsed = PackManifestSchema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return { error: { code: 'manifest_invalid', detail } };
  }
  const manifest = parsed.data;

  if (manifest.id !== path.basename(dir)) {
    return { error: { code: 'manifest_id_mismatch', params: { id: manifest.id, folder: path.basename(dir) } } };
  }
  if (manifest.appearance.entry && !resolveInsidePack(dir, manifest.appearance.entry)) {
    return { error: { code: 'manifest_entry_outside_pack', params: { entry: manifest.appearance.entry } } };
  }
  // Windows can only load files from appearance/ (served via neko-pack://), so the card art must live there
  const card = manifest.appearance.card;
  if (card && !resolveInsidePack(path.join(dir, 'appearance'), path.relative('appearance', card))) {
    return { error: { code: 'manifest_entry_outside_pack', params: { entry: card } } };
  }

  const watchRoots = [...new Set(manifest.source.watch.map((w) => expandPath(w.path, options.env, options.home)))];

  return { pack: { id: manifest.id, dir, dataDir: path.join(dir, 'data'), manifest, watchRoots } };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
