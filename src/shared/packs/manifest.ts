import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

// The pack.json format. A pack holds data and assets only, never code; every
// field below has a concrete use.

export const PACK_FORMAT = 1;

const idPattern = /^[a-z0-9][a-z0-9-]{0,31}$/;
const hexColor = /^#[0-9a-fA-F]{6}$/;

/** Pet behavior rules. Also used to validate the user's overrides from the settings window. */
export const BehaviorSchema = z.object({
  /** Active tokens per day treated as 100% pressure when the mood follows the budget */
  dailyBudget: z.number().int().positive().default(2_000_000),
  /** quota = follow the subscription quota when available; budget = always the daily budget */
  moodBasis: z.enum(['quota', 'budget']).default('quota'),
  /** Pressure % where FOCUSED, SWEATING, PANICKED and EXHAUSTED begin */
  moodThresholds: z
    .tuple([z.number(), z.number(), z.number(), z.number()])
    .refine((t) => t.every((v, i) => v > 0 && v <= 100 && (i === 0 || v > t[i - 1]!)), 'must be 4 increasing percentages')
    .default([30, 60, 80, 95]),
  /** Points the pressure must drop below a threshold before the mood steps down */
  moodHysteresis: z.number().min(0).max(20).default(5),
  /** Quota % that trigger a one-off alert, once per window cycle each */
  alertThresholds: z.array(z.number().gt(0).max(100)).default([50, 80, 95]),
  /** New usage within this many minutes counts as "working" */
  workingMinutes: z.number().positive().default(2),
  idleSleepMinutes: z.number().positive().default(30),
  /** Minimum minutes between two "eat" reactions */
  eatCooldownMinutes: z.number().min(0).default(2),
  /** Random idle chatter every [min, max] minutes while awake; null = off */
  chatterMinutes: z
    .tuple([z.number().positive(), z.number().positive()])
    .refine(([a, b]) => a <= b, 'min must not exceed max')
    .nullable()
    .default([15, 30]),
  bubbleSeconds: z.number().positive().default(6),
});

export type Behavior = z.infer<typeof BehaviorSchema>;

/** The settings window edits these; everything else in `behavior` stays as the pack defines it */
export const EDITABLE_BEHAVIOR = ['dailyBudget', 'moodBasis', 'idleSleepMinutes', 'chatterMinutes'] as const;
export type BehaviorOverride = Partial<Pick<Behavior, (typeof EDITABLE_BEHAVIOR)[number]>>;

/**
 * The pack's behavior with the user's overrides applied. Unknown keys are dropped and
 * an invalid override falls back to the pack's value, so a damaged settings file can
 * never break the pet.
 */
export function applyBehaviorOverride(base: Behavior, override: unknown): Behavior {
  if (!override || typeof override !== 'object') return base;
  let result = base;
  for (const key of EDITABLE_BEHAVIOR) {
    if (!(key in override)) continue;
    const candidate = BehaviorSchema.safeParse({ ...result, [key]: (override as Record<string, unknown>)[key] });
    if (candidate.success) result = candidate.data;
  }
  return result;
}

export const PackManifestSchema = z.object({
  id: z.string().regex(idPattern, 'id may contain only lowercase letters, digits and hyphens'),
  /** Display name. A string, or a map of locale → name, e.g. "Claude" or { "en": "Kimi", "zh-CN": "月之暗面 Kimi" } */
  name: z.union([z.string().min(1), z.record(z.string(), z.string().min(1))]),
  version: z.number().int().positive(),
  packFormat: z.literal(PACK_FORMAT),

  source: z.object({
    /** tokscale client ids; several can be combined. Each client may belong to only one pack. */
    tokscaleClients: z.array(z.string().regex(/^[a-z0-9-]+$/)).min(1),
    /** Provider name in `tokscale usage` output; omit for tools without a subscription quota */
    quotaProvider: z.string().min(1).nullable().default(null),
    /** Log folders to watch live; supports ${ENV|default} and ~ */
    watch: z.array(z.object({ path: z.string().min(1) })).default([]),
    /** Only for tools whose usage arrives late (e.g. synced from the cloud): re-check the last N days once a day; 0 = off */
    lateArrivalDays: z.number().int().min(0).max(35).default(0),
  }),

  /** Pet behavior rules (docs/architecture.md §4); every value has a default */
  behavior: BehaviorSchema.prefault({}),

  /**
   * Brand colour of the tool, used for the pack's launcher card and quota bars.
   * `gradient` (2–4 colours) replaces the solid fill where a brand uses one (e.g. Gemini);
   * `color` stays the solid fallback for text and borders.
   */
  theme: z
    .object({
      color: z.string().regex(hexColor, 'must be a #rrggbb colour').default('#5f5e5a'),
      gradient: z.array(z.string().regex(hexColor, 'must be a #rrggbb colour')).min(2).max(4).optional(),
    })
    .prefault({}),

  appearance: z
    .object({
      renderer: z.enum(['placeholder', 'image', 'frames', 'live2d', 'three']),
      /** Appearance config file, relative to the pack folder; not needed for placeholder */
      entry: z.string().min(1).optional(),
      /** Faded illustration on the launcher card, inside the pack's appearance/ folder */
      card: z.string().min(1).optional(),
    })
    .prefault({ renderer: 'placeholder' }),
});

export type PackManifest = z.infer<typeof PackManifestSchema>;

/** Pick the pack's display name for a locale, falling back to English, then to any name */
export function packName(manifest: PackManifest, locale: string): string {
  if (typeof manifest.name === 'string') return manifest.name;
  return manifest.name[locale] ?? manifest.name.en ?? Object.values(manifest.name)[0] ?? manifest.id;
}

/**
 * Expand variables in a path:
 *   ${CLAUDE_CONFIG_DIR|~/.claude}/projects  →  the env var if set, otherwise the default
 *   ~/xxx                                    →  the user's home folder
 */
export function expandPath(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir()
): string {
  let out = raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:\|([^}]*))?\}/g, (_m, name: string, fallback?: string) => {
    const value = env[name];
    if (value && value.trim()) return value.trim();
    return fallback ?? '';
  });
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    out = path.join(home, out.slice(1));
  }
  return path.normalize(out);
}

/** A relative path inside a pack must stay inside it: no "..", no absolute paths */
export function resolveInsidePack(packDir: string, relative: string): string | null {
  if (path.isAbsolute(relative)) return null;
  const root = path.resolve(packDir);
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}
