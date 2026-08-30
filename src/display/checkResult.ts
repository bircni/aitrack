/**
 * The shape a `doctor` check produces.
 *
 * Lifted out of `src/commands/doctor.ts` so a provider module can return one
 * from its `doctorCheck` without importing the command it feeds.
 */
export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  status: CheckStatus;
  label: string;
  detail: string;
}
