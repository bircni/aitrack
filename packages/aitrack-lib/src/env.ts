/**
 * Reading environment variables the same way everywhere.
 *
 * A variable set to whitespace is set to nothing as far as aitrack is
 * concerned. Raw `process.env` reads scattered across the readers disagreed
 * about that, so an accidental `CURSOR_CONFIG_DIR=" "` behaved differently
 * depending on which one saw it.
 */
export function environmentValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === '' ? undefined : value;
}
