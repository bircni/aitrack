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

/**
 * Calendar date in `timeZone`, or null when the zone was never recorded or is
 * not a real IANA name. `en-CA` formats as YYYY-MM-DD.
 */
export function calendarDateInTimeZone(timeZone: string, now = new Date()): string | null {
  if (timeZone === '' || timeZone === 'unknown') return null;
  try {
    const formatted = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
    return /^\d{4}-\d{2}-\d{2}$/u.test(formatted) ? formatted : null;
  } catch {
    return null;
  }
}
