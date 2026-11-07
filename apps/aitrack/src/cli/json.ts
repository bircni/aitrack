import { log } from 'aitrack-lib/output';

/** Print a machine-readable payload with a stable `{ command, ... }` envelope. */
export function printJsonCommand(command: string, payload: Record<string, unknown>): void {
  console.log(JSON.stringify({ command, ...payload }, null, 2));
}

export function printJsonError(command: string, error: string): void {
  printJsonCommand(command, { error });
}

/** `payload` holds the keys the command's JSON has when it has a result, at their empty values. */
export function printEmptyResult(
  command: string,
  json: boolean | undefined,
  message: string,
  payload: Record<string, unknown> = {},
): void {
  if (json) printJsonCommand(command, { ...payload, message });
  else log.info(message);
}
