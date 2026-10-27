import type { ErrorInfo } from '../errors.ts';
import { en, type MessageKey } from './en.ts';
import { zhCN } from './zh-CN.ts';

// Every human-readable string goes through t(). English is the default and the
// fallback; adding a language = adding one dictionary file and one line below.

export type Locale = 'en' | 'zh-CN';

const DICTIONARIES: Record<Locale, Partial<Record<MessageKey, string>>> = {
  en,
  'zh-CN': zhCN,
};

export const LOCALES = Object.keys(DICTIONARIES) as Locale[];

export function isLocale(value: string): value is Locale {
  return (LOCALES as string[]).includes(value);
}

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

export function translator(locale: Locale = 'en'): Translate {
  const dict = DICTIONARIES[locale];
  return (key, params) => format(dict[key] ?? en[key], params);
}

/** Render a stored error in the given language; the raw detail is appended untranslated. */
export function describeError(t: Translate, error: ErrorInfo): string {
  const text = t(`error.${error.code}`, error.params);
  return error.detail ? `${text} (${error.detail})` : text;
}

function format(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}
