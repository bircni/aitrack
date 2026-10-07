/** A variable set to whitespace counts as unset. */
export function environmentValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === '' ? undefined : value;
}
