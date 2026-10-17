/** A bad argument or option combination; exits 2 where other failures exit 1. */
export class UsageError extends Error {}

export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
