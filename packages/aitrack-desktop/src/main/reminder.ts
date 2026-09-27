export const RATE_REMINDER_MS = 7 * 24 * 60 * 60 * 1000;

export function unratedLabel(count: number): string {
  const sessions = count === 1 ? 'session' : 'sessions';
  return `${String(count)} ${sessions} to rate`;
}

/** A sentence when a weekly reminder is due, otherwise nothing. */
export function ratingReminder(input: {
  enabled: boolean;
  unrated: number;
  lastAt: string | null;
  now: number;
}): string | null {
  if (!input.enabled || input.unrated < 1) return null;
  if (input.lastAt !== null) {
    const last = Date.parse(input.lastAt);
    if (!Number.isNaN(last) && input.now - last < RATE_REMINDER_MS) return null;
  }
  return unratedLabel(input.unrated);
}
