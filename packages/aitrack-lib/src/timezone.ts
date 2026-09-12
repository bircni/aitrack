/**
 * IANA zone of this machine, recorded on machine files and used as a parse-cache
 * key. Day keys are local calendar days, so a cache written in another zone
 * must not be reused.
 */
export function machineTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
