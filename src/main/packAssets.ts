import { net, protocol } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ImageAppearanceSchema, type ImageAppearance } from '../shared/appearance.ts';
import type { Locale } from '../shared/i18n/index.ts';
import { mergeLines, parseLinesFile, type Lines } from '../shared/lines.ts';
import { resolveInsidePack } from '../shared/packs/manifest.ts';
import type { LoadedPack } from '../shared/packs/registry.ts';

// Pack assets for the windows. Renderers are sandboxed and cannot read files,
// so a pack's appearance files are served through the neko-pack:// protocol:
//   neko-pack://<packId>/<path inside appearance/>
// Only files inside that pack's appearance/ folder are reachable.

export const PACK_SCHEME = 'neko-pack';

/** Must run before app "ready" */
export function registerPackScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: PACK_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  ]);
}

export function servePackAssets(packs: LoadedPack[]): void {
  const byId = new Map(packs.map((p) => [p.id, p]));
  protocol.handle(PACK_SCHEME, async (request) => {
    const url = new URL(request.url);
    const pack = byId.get(url.hostname);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = pack ? resolveInsidePack(path.join(pack.dir, 'appearance'), relative) : null;
    if (!file) return new Response('Not found', { status: 404 });
    const response = await net.fetch(pathToFileURL(file).toString());
    // Allow canvas pixel reads (alpha hit testing) from the window's origin
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(response.body, { status: response.status, headers });
  });
}

export function assetBase(pack: LoadedPack): string {
  return `${PACK_SCHEME}://${pack.id}/`;
}

/** URL of the pack's launcher card illustration, or null if it has none */
export function cardArtUrl(pack: LoadedPack): string | null {
  const card = pack.manifest.appearance.card;
  if (!card) return null;
  const relative = path.relative(path.join(pack.dir, 'appearance'), path.resolve(pack.dir, card));
  return assetBase(pack) + relative.split(path.sep).map(encodeURIComponent).join('/');
}

/** The pack's lines for a language, merged with its English lines and the core defaults */
export async function loadLines(pack: LoadedPack, locale: Locale): Promise<Lines> {
  const read = async (name: string) => {
    try {
      return parseLinesFile(JSON.parse(await fs.readFile(path.join(pack.dir, 'lines', `${name}.json`), 'utf8')));
    } catch {
      return null;
    }
  };
  return mergeLines(locale, locale === 'en' ? null : await read(locale), await read('en'));
}

/**
 * The image renderer's config. Returns null when the pack uses another renderer,
 * or when the config is missing or invalid (the pet then uses the placeholder).
 */
export async function loadImageAppearance(pack: LoadedPack): Promise<ImageAppearance | null> {
  const { renderer, entry } = pack.manifest.appearance;
  if (renderer !== 'image' || !entry) return null;
  const file = resolveInsidePack(pack.dir, entry);
  if (!file) return null;
  try {
    const parsed = ImageAppearanceSchema.safeParse(JSON.parse(await fs.readFile(file, 'utf8')));
    if (!parsed.success) return null;
    // Image paths in appearance.json are relative to its own folder; rebase them onto appearance/
    const appearanceDir = path.join(pack.dir, 'appearance');
    const baseDir = path.dirname(file);
    const images: Record<string, string> = {};
    for (const [key, rel] of Object.entries(parsed.data.images)) {
      const abs = resolveInsidePack(baseDir, rel);
      const fromAppearance = abs ? path.relative(appearanceDir, abs) : null;
      if (fromAppearance && !fromAppearance.startsWith('..')) images[key] = fromAppearance.split(path.sep).join('/');
    }
    if (!images['mood.ENERGETIC']) return null;
    return { ...parsed.data, images };
  } catch {
    return null;
  }
}
