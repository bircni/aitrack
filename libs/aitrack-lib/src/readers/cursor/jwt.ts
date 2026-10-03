import { Buffer } from 'node:buffer';

import { isFiniteNumber, isRecord } from '../../data/guards.js';

/**
 * Reading claims out of an access token.
 *
 * The payload is untrusted remote input, so every step here has to tolerate
 * garbage rather than assume a well-formed token.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const encodedPayload = token.split('.', 2)[1];
  if (!encodedPayload) return null;
  const base64 = encodedPayload.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  try {
    const payload: unknown = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

/** The token's `exp` claim in epoch ms. */
export function jwtExpiryMs(token: string): number | undefined {
  const exp = decodeJwtPayload(token)?.exp;
  return isFiniteNumber(exp) ? exp * 1000 : undefined;
}
