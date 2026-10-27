import { execFile } from 'node:child_process';

// Quota queries go over the network. tokscale (a Rust program) does not pick up the
// Windows system proxy, so when the system proxy is *enabled* we pass its address via
// HTTPS_PROXY. When it is disabled we pass nothing, so requests are never sent to a
// proxy that is no longer running.

const CACHE_MS = 60_000;
let cached: { at: number; env: Record<string, string> } | null = null;

export async function proxyEnv(env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
  if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy) return {};
  if (process.platform !== 'win32') return {};
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.env;

  const server = await readWindowsProxy();
  const result: Record<string, string> = server
    ? { HTTPS_PROXY: server, HTTP_PROXY: server, NO_PROXY: 'localhost,127.0.0.1,::1' }
    : {};
  cached = { at: Date.now(), env: result };
  return result;
}

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

async function readWindowsProxy(): Promise<string | null> {
  const enable = await regQuery('ProxyEnable');
  if (!enable || !/0x1\b/.test(enable)) return null;
  const value = (await regQuery('ProxyServer'))?.match(/REG_SZ\s+(\S+)/)?.[1];
  return value ? parseProxyServer(value) : null;
}

/** Parse the registry ProxyServer value: either "127.0.0.1:7897" or "http=...;https=..." */
export function parseProxyServer(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.includes('=')) {
    const parts = new Map(
      trimmed.split(';').map((part) => {
        const [k = '', v = ''] = part.split('=');
        return [k.trim().toLowerCase(), v.trim()] as const;
      })
    );
    const pick = parts.get('https') || parts.get('http');
    return pick ? withScheme(pick) : null;
  }
  return withScheme(trimmed);
}

function withScheme(value: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
}

function regQuery(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('reg', ['query', KEY, '/v', name], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}
