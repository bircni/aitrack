/*
 * Calendar arithmetic on YYYY-MM-DD strings.
 *
 * Every helper here takes and returns local calendar date strings; none reads a
 * clock. They go through UTC purely because it has no DST discontinuities — the
 * strings are local dates and are never re-interpreted against a wall clock.
 * Reading local fields (today.getMonth()) while building with Date.UTC is what
 * makes this kind of code drift by a day, so the two are kept apart.
 */

function parseDateString(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function formatDateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function yearOf(date: string): number {
  return Number(date.slice(0, 4));
}

/** 1-based, to match how the string reads. */
function monthOf(date: string): number {
  return Number(date.slice(5, 7));
}

function dayOf(date: string): number {
  return Number(date.slice(8, 10));
}

export function shiftDate(value: string, days: number): string {
  const date = parseDateString(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateString(date);
}

/** First day of the month `offset` months from the one `date` falls in. */
export function shiftMonthStart(date: string, offset: number): string {
  return formatDateString(new Date(Date.UTC(yearOf(date), monthOf(date) - 1 + offset, 1)));
}

/** Last day of the month `offset` months from the one `date` falls in. */
export function shiftMonthEnd(date: string, offset: number): string {
  return formatDateString(new Date(Date.UTC(yearOf(date), monthOf(date) + offset, 0)));
}

/**
 * The same day of the month, `offset` months away, clamped to that month's
 * length — the 31st compared against a 30-day month lands on the 30th.
 */
export function shiftMonthSameDay(date: string, offset: number): string {
  const start = shiftMonthStart(date, offset);
  const lastDay = dayOf(shiftMonthEnd(date, offset));
  return `${start.slice(0, 8)}${String(Math.min(dayOf(date), lastDay)).padStart(2, '0')}`;
}

/** The same month and day in another year, clamped so Feb 29 survives. */
export function sameDayInYear(date: string, year: number): string {
  const target = `${String(year).padStart(4, '0')}${date.slice(4)}`;
  const lastDay = dayOf(shiftMonthEnd(target, 0));
  return `${target.slice(0, 8)}${String(Math.min(dayOf(date), lastDay)).padStart(2, '0')}`;
}

/** Monday of the week `date` falls in. */
export function mondayOfWeek(date: string): string {
  return shiftDate(date, -((weekdayOf(date) + 6) % 7));
}

/** Day of the week a calendar date falls on, 0 = Sunday. */
function weekdayOf(date: string): number {
  return parseDateString(date).getUTCDay();
}

/** Number of days from `start` to `end`, inclusive of both ends. */
export function inclusiveDayCount(start: string, end: string): number {
  const milliseconds = parseDateString(end).getTime() - parseDateString(start).getTime();
  return Math.floor(milliseconds / 86_400_000) + 1;
}
