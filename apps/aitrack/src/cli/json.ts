/** Print a machine-readable payload with a stable `{ command, ... }` envelope. */
export function printJsonCommand(command: string, payload: Record<string, unknown>): void {
  console.log(JSON.stringify({ command, ...payload }, null, 2));
}
