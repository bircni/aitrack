/**
 * Structural type guards shared by the two hand-rolled validators: the config
 * loader and the machine-file parser. Both read untrusted JSON off disk and
 * narrow it field by field, so they need exactly the same primitives.
 */

/** A plain JSON object — arrays and null are excluded so index access is safe. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A real number: rejects NaN and ±Infinity, which survive JSON round-trips as null. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
