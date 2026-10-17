/** Wraps `console.*` rather than `process.stdout` to keep its stdout/stderr split. */
export interface Logger {
  /** Progress and results. Suppressed when quiet. */
  info: (message: string) => void;
  /** Recoverable problems. Never suppressed. */
  warn: (message: string) => void;
  /** Failures. Never suppressed. */
  error: (message: string) => void;
}

export function createLogger(options: { quiet?: boolean } = {}): Logger {
  return {
    info: options.quiet
      ? () => undefined
      : (message) => {
          console.log(message);
        },
    warn: (message) => {
      console.warn(message);
    },
    error: (message) => {
      console.error(message);
    },
  };
}

/** Default sink for command output; machine-readable output goes through `cli/json.ts` instead. */
export const log: Logger = createLogger();

/** For `--json` runs: stdout must hold only the JSON document, so progress moves to stderr. */
export function routeInfoToStderr(): void {
  log.info = (message) => {
    console.error(message);
  };
}
