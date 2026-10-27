// Errors are stored and passed around as codes plus parameters, never as
// sentences, so every user-facing language can render them (see i18n/).
// `detail` carries raw technical text (e.g. a tokscale stderr line) for
// diagnostics; it is shown as-is and never translated.

export type ErrorCode =
  | 'packs_dir_unreadable'
  | 'manifest_missing'
  | 'manifest_invalid_json'
  | 'manifest_invalid'
  | 'manifest_id_mismatch'
  | 'manifest_entry_outside_pack'
  | 'client_already_claimed'
  | 'tokscale_not_found'
  | 'tokscale_spawn_failed'
  | 'tokscale_timeout'
  | 'tokscale_exit'
  | 'tokscale_output_too_large'
  | 'tokscale_bad_output'
  | 'tokscale_stopped'
  | 'quota_provider_missing'
  | 'history_unreadable'
  | 'history_days_failed'
  | 'data_locked'
  | 'write_failed'
  | 'unexpected';

export type ErrorParams = Record<string, string | number>;

export interface ErrorInfo {
  code: ErrorCode;
  params?: ErrorParams;
  detail?: string;
}

export class NekoError extends Error {
  readonly code: ErrorCode;
  readonly params: ErrorParams | undefined;
  readonly detail: string | undefined;

  constructor(info: ErrorInfo) {
    super(info.detail ? `${info.code}: ${info.detail}` : info.code);
    this.name = 'NekoError';
    this.code = info.code;
    this.params = info.params;
    this.detail = info.detail;
  }

  toInfo(): ErrorInfo {
    return { code: this.code, ...(this.params && { params: this.params }), ...(this.detail && { detail: this.detail }) };
  }
}

export function toErrorInfo(err: unknown): ErrorInfo {
  if (err instanceof NekoError) return err.toInfo();
  return { code: 'unexpected', detail: err instanceof Error ? err.message : String(err) };
}
