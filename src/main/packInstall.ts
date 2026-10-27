import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

// Where packs live:
//   development  <project>/packs
//   installed    <userData>/packs, because the install folder (Program Files) is read-only
//                and each pack's data/ is written at runtime.
// The installer ships the packs in resources/packs (without data/). They are copied to the
// user folder on first run and again whenever the app version changes, so updated art and
// pack.json reach the user. A pack's data/ folder is never touched.

const MARKER = '.bundled-version';

export async function resolvePacksRoot(): Promise<string> {
  if (!app.isPackaged) return path.join(app.getAppPath(), 'packs');

  const bundled = path.join(process.resourcesPath, 'packs');
  const target = path.join(app.getPath('userData'), 'packs');
  const version = app.getVersion();
  const installed = await fs.readFile(path.join(target, MARKER), 'utf8').catch(() => null);
  if (installed?.trim() === version) return target;

  try {
    await fs.mkdir(target, { recursive: true });
    for (const entry of await fs.readdir(bundled, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const from = path.join(bundled, entry.name);
      const to = path.join(target, entry.name);
      for (const item of await fs.readdir(from)) {
        if (item === 'data') continue;
        await fs.rm(path.join(to, item), { recursive: true, force: true });
        await fs.cp(path.join(from, item), path.join(to, item), { recursive: true });
      }
    }
    await fs.writeFile(path.join(target, MARKER), version);
  } catch (err) {
    // A partial copy is retried next start (no marker written); the loader skips broken packs
    console.error('[packs] could not install the bundled packs', err);
  }
  return target;
}
