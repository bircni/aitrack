export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** Print a machine-readable payload with a stable `{ command, ... }` envelope. */
export function printJsonCommand(command: string, payload: Record<string, unknown>): void {
  printJson({ command, ...payload });
}
