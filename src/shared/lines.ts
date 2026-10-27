import type { Locale } from './i18n/index.ts';
import type { LineKey } from './pet.ts';

// The pet's lines. A pack provides lines/<locale>.json (key → list of variants);
// anything missing falls back to the pack's English file, then to these core
// defaults. The brain only emits keys (src/shared/pet.ts).

export type Lines = Record<string, string[]>;

/** Used for any event.quota.<N> the pack has no specific line for */
export const QUOTA_FALLBACK_KEY = 'event.quota.any';

const EN: Lines = {
  'mood.ENERGETIC': ['Full of energy today~', 'Ready when you are!'],
  'mood.FOCUSED': ['Working hard~', 'In the zone.'],
  'mood.SWEATING': ['Quota is getting tight…', 'Maybe pace yourself a bit?'],
  'mood.PANICKED': ['We are running low!', 'Careful, almost out!'],
  'mood.EXHAUSTED': ['I am completely drained…', 'No quota left to give…'],
  'user.poke': ['Hey!', 'Hm?', 'What is it?'],
  'user.pokeAnnoyed': ['Stop poking me!', 'That is enough!'],
  'user.drag': ['Whoa, where are we going?'],
  'user.land': ['Landed!'],
  'event.eat': ['Nom nom~', 'Tasty tokens!'],
  [QUOTA_FALLBACK_KEY]: ['Quota passed {percent}%!'],
  'event.quota.reset': ['Quota refreshed! Let us go again!'],
  'event.wake': ['Mm… I am awake.', '*yawn* Back to work?'],
  'event.newDay': ['A brand new day!'],
};

const ZH_CN: Lines = {
  'mood.ENERGETIC': ['今天也元气满满～', '随时可以开工！'],
  'mood.FOCUSED': ['认真干活中～', '专注模式。'],
  'mood.SWEATING': ['额度有点紧张了…', '要不要悠着点？'],
  'mood.PANICKED': ['额度快不够了！', '小心，快用完了！'],
  'mood.EXHAUSTED': ['我已经被榨干了…', '一点额度都不剩了…'],
  'user.poke': ['干嘛～', '嗯？', '怎么啦？'],
  'user.pokeAnnoyed': ['别戳啦！', '够了够了！'],
  'user.drag': ['哇，要去哪里？'],
  'user.land': ['着陆！'],
  'event.eat': ['啊呜啊呜～', 'token 真好吃！'],
  [QUOTA_FALLBACK_KEY]: ['额度已经用了 {percent}%！'],
  'event.quota.reset': ['额度刷新啦！再出发！'],
  'event.wake': ['嗯…醒了。', '哈欠～继续干活吗？'],
  'event.newDay': ['新的一天开始啦！'],
};

export const DEFAULT_LINES: Record<Locale, Lines> = { en: EN, 'zh-CN': ZH_CN };

/** Merge, highest priority first: pack lines in the locale → pack English → core locale → core English */
export function mergeLines(locale: Locale, packLocale: Lines | null, packEnglish: Lines | null): Lines {
  return { ...EN, ...DEFAULT_LINES[locale], ...(packEnglish ?? {}), ...(locale === 'en' ? {} : packLocale ?? {}) };
}

/**
 * Text for a bubble. `seed` (the bubble id) picks the variant, so the same bubble
 * always shows the same text and each new bubble may show a different one.
 */
export function resolveLine(lines: Lines, key: LineKey, seed: number, params: Record<string, string | number> = {}): string {
  const variants = lines[key] ?? (key.startsWith('event.quota.') && key !== 'event.quota.reset' ? lines[QUOTA_FALLBACK_KEY] : undefined);
  if (!variants?.length) return '';
  const text = variants[Math.abs(seed) % variants.length]!;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

/** Parse a pack's lines file leniently: keep string-array (or string) entries, drop the rest */
export function parseLinesFile(json: unknown): Lines {
  const out: Lines = {};
  if (!json || typeof json !== 'object') return out;
  for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim()) out[key] = [value];
    else if (Array.isArray(value)) {
      const list = value.filter((v): v is string => typeof v === 'string' && !!v.trim());
      if (list.length) out[key] = list;
    }
  }
  return out;
}
