import { Buffer } from 'node:buffer';

/**
 * Reading the subject out of Cursor's access token.
 *
 * The payload is untrusted remote input, so every step here has to tolerate
 * garbage rather than assume a well-formed token.
 */
export function decodeJwtPayload(token: string): { sub?: string } | null {
  const encodedPayload = token.split('.', 2)[1];
  if (!encodedPayload) return null;
  const base64 = encodedPayload.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  try {
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as { sub?: string };
  } catch {
    return null;
  }
}
