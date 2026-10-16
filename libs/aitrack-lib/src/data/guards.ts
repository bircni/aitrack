/** A plain JSON object — arrays and null are excluded so index access is safe. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A real number: rejects NaN and ±Infinity, which survive JSON round-trips as null. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

/** A trimmed string, or undefined when it is blank or not a string. */
export function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
