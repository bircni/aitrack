/**
 * The single place aitrack writes human-readable output.
 *
 * Commands used to call `console.*` directly from ~20 modules, including the
 * domain layer, so there was no way to silence progress chatter. `log` is what
 * the CLI prints through; `createLogger({ quiet: true })` is for an embedder
 * that wants the work without the running commentary.
 *
 * These wrap `console.*` rather than `process.stdout` on purpose: it keeps the
 * stdout/stderr split that `console.log` and `console.warn` already imply, and
 * it keeps the existing test suite's console spies working.
 */
export interface Logger {
  /** Progress and results. Suppressed when quiet. */
  info: (message: string) => void;
  /** Recoverable problems. Never suppressed. */
  warn: (message: string) => void;
  /** Failures. Never suppressed. */
  error: (message: string) => void;
}

function emit(stream: 'log' | 'warn' | 'error', message: string): void {
  console[stream](message);
}

export function createLogger(options: { quiet?: boolean } = {}): Logger {
  const quiet = options.quiet ?? false;
  return {
    info: quiet
      ? () => undefined
      : (message) => {
          emit('log', message);
        },
    warn: (message) => {
      emit('warn', message);
    },
    error: (message) => {
      emit('error', message);
    },
  };
}

/**
 * Default sink for command output.
 *
 * Machine-readable output does not go through here — see `cli/json.ts`, which
 * must stay uncolored, on stdout, and free of interleaved log lines.
 */
export const log: Logger = createLogger();
