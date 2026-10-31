import { readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandPath } from '../shared/packs/manifest.ts';

// Local, read-only Claude quota sources (docs/architecture.md §3.3).
//
// 1. Claude desktop writes a quota sample about every 15 minutes while it runs:
//      %LOCALAPPDATA%\Claude-Data\claude_<package>\plan-usage-history.json   (Microsoft Store install)
//      { version: 2, samples: [{ t: <ms>, org, u: { fh: <5-hour used %>, sd: <7-day used %> } }] }
//    The file is undocumented, so only version 2 is accepted. It has no reset times.
// 2. The command-line Claude Code keeps its sign-in in ~/.claude/.credentials.json. tokscale uses
//    that access token for its quota query and never refreshes it; only running `claude` does.
//    We read the expiry time and nothing else: the tokens are never kept, logged or sent.

export interface DesktopSample {
  /** Epoch milliseconds */
  at: number;
  session: number | null;
  weekly: number | null;
}

export interface LocalQuotaSource {
  /** Changes whenever one of the files changes; cheap enough for the 30-second heartbeat */
  fingerprint(): string;
  /** The newest desktop sample, or null when Claude desktop has none */
  desktopSample(): DesktopSample | null;
  /** When the command-line access token expires; null when unknown (no file, or kept elsewhere) */
  tokenExpiresAt(): number | null;
}

export interface ClaudeLocalPaths {
  usageFiles: () => string[];
  credentialsFile: string;
}

export function defaultClaudePaths(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): ClaudeLocalPaths {
  const local = expandPath('${LOCALAPPDATA|~/AppData/Local}', env, home);
  const roaming = expandPath('${APPDATA|~/AppData/Roaming}', env, home);
  return {
    usageFiles: () => {
      const files = [path.join(roaming, 'Claude', 'plan-usage-history.json')];
      const dataRoot = path.join(local, 'Claude-Data');
      try {
        for (const name of readdirSync(dataRoot)) {
          if (/^claude_/i.test(name)) files.push(path.join(dataRoot, name, 'plan-usage-history.json'));
        }
      } catch {
        // No Store install
      }
      return files;
    },
    credentialsFile: path.join(expandPath('${CLAUDE_CONFIG_DIR|~/.claude}', env, home), '.credentials.json'),
  };
}

export function claudeLocalSource(paths: ClaudeLocalPaths = defaultClaudePaths()): LocalQuotaSource {
  return {
    fingerprint: () => [...paths.usageFiles(), paths.credentialsFile].map(mtime).join('|'),
    desktopSample: () => {
      let best: DesktopSample | null = null;
      for (const file of paths.usageFiles()) {
        const sample = readDesktopSample(file);
        if (sample && (!best || sample.at > best.at)) best = sample;
      }
      return best;
    },
    tokenExpiresAt: () => readTokenExpiry(paths.credentialsFile),
  };
}

function mtime(file: string): string {
  try {
    return String(statSync(file).mtimeMs);
  } catch {
    return '-';
  }
}

export function readDesktopSample(file: string): DesktopSample | null {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(data) || data.version !== 2 || !Array.isArray(data.samples)) return null;
  for (let i = data.samples.length - 1; i >= 0; i--) {
    const s: unknown = data.samples[i];
    if (!isRecord(s) || typeof s.t !== 'number' || !isRecord(s.u)) continue;
    const session = percent(s.u.fh);
    const weekly = percent(s.u.sd);
    if (session == null && weekly == null) continue;
    return { at: s.t, session, weekly };
  }
  return null;
}

export function readTokenExpiry(file: string): number | null {
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const oauth = isRecord(data) ? data.claudeAiOauth : null;
    return isRecord(oauth) && typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null;
  } catch {
    return null;
  }
}

function percent(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
