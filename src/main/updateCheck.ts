import { app, net, shell } from 'electron';
import type { UpdateState } from '../shared/ipc.ts';
import { compareVersions } from '../shared/version.ts';

// "Check for updates" in the panel: asks GitHub for the latest release and compares
// its tag with this build's version. Nothing is downloaded or installed here; when a
// newer version exists, the panel offers to open its release page in the browser.

const REPO = 'zhangpl666ya/NekoQuotya';
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASE_PAGE_PREFIX = `https://github.com/${REPO}/releases/`;
const TIMEOUT_MS = 15_000;

let releaseUrl: string | null = null;

export async function checkForUpdate(): Promise<UpdateState> {
  try {
    // net.fetch goes through Chromium's network stack, so the system proxy applies
    const res = await net.fetch(LATEST_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `NekoQuotya/${app.getVersion()}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { state: 'error' };
    const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
    const latest = typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/i, '') : null;
    if (!latest || !/^\d+\.\d+\.\d+/.test(latest)) return { state: 'error' };
    releaseUrl = typeof body.html_url === 'string' && body.html_url.startsWith(RELEASE_PAGE_PREFIX) ? body.html_url : `${RELEASE_PAGE_PREFIX}latest`;
    return compareVersions(latest, app.getVersion()) > 0 ? { state: 'available', version: latest } : { state: 'latest', version: app.getVersion() };
  } catch {
    return { state: 'error' };
  }
}

/** Open the newer release's page; only this repository's release pages are ever opened */
export function openReleasePage(): void {
  void shell.openExternal(releaseUrl ?? `${RELEASE_PAGE_PREFIX}latest`);
}
