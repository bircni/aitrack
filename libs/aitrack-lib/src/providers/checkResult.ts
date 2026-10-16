export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  status: CheckStatus;
  label: string;
  detail: string;
}
