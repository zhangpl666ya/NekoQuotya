import { z } from 'zod';
import type { PetIntent } from './pet.ts';

// Appearance config for the `image` renderer (appearance/appearance.json in a pack).
// Image keys are visual keys: mood.<MOOD>, action.<ACTION>, activity.sleeping.
// Only mood.ENERGETIC is required; everything else falls back (see visualKeys).

export const ImageAppearanceSchema = z.object({
  /** Canvas size of the character in pixels */
  size: z.tuple([z.number().int().min(32).max(2048), z.number().int().min(32).max(2048)]),
  /** The character's "feet" within the canvas; reserved for edge snapping */
  anchor: z.tuple([z.number(), z.number()]).optional(),
  /** Visual key → image path relative to the appearance folder */
  images: z
    .record(z.string(), z.string().min(1))
    .refine((m) => 'mood.ENERGETIC' in m, 'images must include "mood.ENERGETIC"'),
});

export type ImageAppearance = z.infer<typeof ImageAppearanceSchema>;

/** Visual keys to try for an intent, most specific first */
export function visualKeys(intent: Pick<PetIntent, 'mood' | 'activity' | 'action'>): string[] {
  const keys: string[] = [];
  if (intent.action) keys.push(`action.${intent.action.id}`);
  if (intent.activity === 'sleeping') keys.push('activity.sleeping');
  keys.push(`mood.${intent.mood}`, 'mood.ENERGETIC');
  return keys;
}

export function pickVisual(available: Iterable<string>, intent: Pick<PetIntent, 'mood' | 'activity' | 'action'>): string {
  const set = new Set(available);
  return visualKeys(intent).find((k) => set.has(k)) ?? 'mood.ENERGETIC';
}
