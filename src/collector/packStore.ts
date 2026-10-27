import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NekoError } from '../shared/errors.ts';
import type { HistoryData, PackSnapshot, QuotaData, StatusData, TodayData } from '../shared/types.ts';
import { localDate } from '../shared/usage.ts';

// Each pack's runtime data lives in its own data/ folder.
// Writes are atomic (temp file + rename), so readers never see half a file.
//
// history.json is the ledger and may hold sessions that can no longer be rebuilt
// from logs. So:
//  · a read failure is never treated as "empty" (that would overwrite it)
//  · before the first write of each day, the current ledger is copied to
//    backups/history-YYYY-MM-DD.json; the newest BACKUP_KEEP copies are kept
//  · if the ledger is unreadable, the newest readable backup is restored and the
//    damaged file is kept aside as history.corrupt-<time>.json

const FILES = {
  today: 'today.json',
  history: 'history.json',
  quota: 'quota.json',
  status: 'status.json',
} as const;

const SCHEMA = 1;
export const BACKUP_KEEP = 7;
const BACKUP_DIR = 'backups';
const BACKUP_FILE = /^history-\d{4}-\d{2}-\d{2}\.json$/;

type Kind = keyof typeof FILES;
type DataOf = { today: TodayData; history: HistoryData; quota: QuotaData; status: StatusData };

export interface LoadResult {
  snapshot: PackSnapshot;
  /** Backup file the ledger was restored from, if it had to be */
  recoveredFrom: string | null;
}

export class PackStore {
  readonly packId: string;
  readonly dataDir: string;
  private readonly now: () => number;
  private backedUpOn: string | null = null;

  constructor(packId: string, dataDir: string, now: () => number = Date.now) {
    this.packId = packId;
    this.dataDir = dataDir;
    this.now = now;
  }

  /** Read everything. Throws history_unreadable if the ledger and all backups are unreadable. */
  async load(): Promise<LoadResult> {
    const [today, ledger, quota, status] = await Promise.all([
      this.read('today'),
      this.readHistory(),
      this.read('quota'),
      this.read('status'),
    ]);
    return {
      snapshot: { packId: this.packId, today, history: ledger.history, quota, status },
      recoveredFrom: ledger.recoveredFrom,
    };
  }

  /** Cache files: missing, damaged or outdated means "none"; the next scan regenerates them */
  async read<K extends Exclude<Kind, 'history'>>(kind: K): Promise<DataOf[K] | null> {
    try {
      const json = JSON.parse(await fs.readFile(path.join(this.dataDir, FILES[kind]), 'utf8'));
      return json && json.schema === SCHEMA ? (json as DataOf[K]) : null;
    } catch {
      return null;
    }
  }

  /** The ledger: only a missing file counts as empty; anything else is recovered from backup or reported */
  async readHistory(): Promise<{ history: HistoryData | null; recoveredFrom: string | null }> {
    const file = path.join(this.dataDir, FILES.history);
    let problem: string;
    try {
      return { history: parseHistory(await fs.readFile(file, 'utf8')), recoveredFrom: null };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { history: null, recoveredFrom: null };
      problem = (err as Error).message;
    }

    for (const backup of await this.listBackups()) {
      try {
        const raw = await fs.readFile(path.join(this.dataDir, BACKUP_DIR, backup), 'utf8');
        const history = parseHistory(raw);
        const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
        await fs.rename(file, path.join(this.dataDir, `history.corrupt-${stamp}.json`)).catch(() => {});
        await writeTextAtomic(file, raw);
        return { history, recoveredFrom: backup };
      } catch {
        // try the next older backup
      }
    }
    throw new NekoError({ code: 'history_unreadable', detail: `${file}: ${problem}` });
  }

  async write<K extends Kind>(kind: K, data: DataOf[K]): Promise<void> {
    if (kind === 'history') await this.backupHistoryOnce();
    await writeJsonAtomic(path.join(this.dataDir, FILES[kind]), data);
  }

  /** Newest first */
  async listBackups(): Promise<string[]> {
    try {
      const names = await fs.readdir(path.join(this.dataDir, BACKUP_DIR));
      return names.filter((n) => BACKUP_FILE.test(n)).sort().reverse();
    } catch {
      return [];
    }
  }

  private async backupHistoryOnce(): Promise<void> {
    const today = localDate(this.now());
    if (this.backedUpOn === today) return;
    const source = path.join(this.dataDir, FILES.history);
    const dir = path.join(this.dataDir, BACKUP_DIR);
    const target = path.join(dir, `history-${today}.json`);
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ENOENT: no ledger yet; EEXIST: already backed up today (e.g. by an earlier run)
      if (code !== 'ENOENT' && code !== 'EEXIST') throw err;
    }
    this.backedUpOn = today;
    for (const old of (await this.listBackups()).slice(BACKUP_KEEP)) {
      await fs.rm(path.join(dir, old), { force: true });
    }
  }
}

function parseHistory(raw: string): HistoryData {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('not valid JSON');
  }
  const h = json as Partial<HistoryData> | null;
  if (!h || h.schema !== SCHEMA || typeof h.days !== 'object' || h.days === null) {
    throw new Error(`unsupported format version: ${String(h?.schema)}`);
  }
  return h as HistoryData;
}

export function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  return writeTextAtomic(file, JSON.stringify(data, null, 2) + '\n');
}

async function writeTextAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  // On Windows the rename can briefly fail while antivirus or another reader holds the target; retry
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        await fs.rm(tmp, { force: true });
        throw err;
      }
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}
