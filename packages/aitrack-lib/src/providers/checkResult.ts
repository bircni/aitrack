/**
 * The shape a `doctor` check produces.
 *
 * Owned by the provider layer: each provider's `doctorCheck` returns one, and
 * the CLI only formats it.
 */
export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  status: CheckStatus;
  label: string;
  detail: string;
}
