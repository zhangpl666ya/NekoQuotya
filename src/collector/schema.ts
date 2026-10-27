import { z } from 'zod';
import { NekoError } from '../shared/errors.ts';

// Shapes of tokscale's JSON output (as measured on 4.20.1). Only the fields we use
// are declared; the rest is ignored. A shape mismatch is an error rather than half
// a dataset written into the ledger.

const count = z.number().finite().nonnegative();
const cost = z.number().finite().nullable().optional().transform((v) => (v && v > 0 ? v : 0));

/** `tokscale --json ... --group-by client,session,model` */
export const SessionReportSchema = z.object({
  entries: z.array(
    z.object({
      client: z.string().min(1),
      sessionId: z.string().min(1),
      model: z.string(),
      input: count,
      output: count,
      cacheRead: count,
      cacheWrite: count,
      reasoning: count.default(0),
      messageCount: count,
      cost,
    })
  ),
});
export type TokscaleSessionReport = z.infer<typeof SessionReportSchema>;

/** `tokscale usage --json` */
export const UsageSchema = z.array(
  z.object({
    provider: z.string(),
    plan: z.string().nullable().optional(),
    metrics: z.array(
      z.object({
        label: z.string(),
        used_percent: z.number().finite().nullable().optional(),
        remaining_percent: z.number().finite().nullable().optional(),
        remaining_label: z.string().nullable().optional(),
        resets_at: z.string().nullable().optional(),
      })
    ),
  })
);
export type TokscaleUsage = z.infer<typeof UsageSchema>;

/** Parse and validate JSON; throws tokscale_bad_output with a short technical detail */
export function parseWith<T>(schema: z.ZodType<T>, stdout: string, what: string): T {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new NekoError({ code: 'tokscale_bad_output', detail: `${what}: not valid JSON` });
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new NekoError({
      code: 'tokscale_bad_output',
      detail: `${what}: ${issue ? `${issue.path.join('.')} ${issue.message}` : 'unexpected shape'}`,
    });
  }
  return result.data;
}
