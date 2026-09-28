/**
 * Message for anything thrown into an `unknown` catch binding.
 *
 * `catch` bindings are `unknown`, so every reporting site needs this narrowing.
 * It used to be hand-inlined in six places, which meant six chances to print
 * `[object Object]` for a non-Error throw.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
