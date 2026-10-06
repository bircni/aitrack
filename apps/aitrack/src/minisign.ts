import { createHash, createPublicKey, verify } from 'node:crypto';

/** Same key as `plugins.updater.pubkey` in apps/opentrack/tauri.conf.json. */
export const OPENTRACK_PUBLIC_KEY =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEJDMTk5RTc3QkFBMURBQzEKUldUQjJxRzZkNTRadkdJTDNlb0l2NDNBVTVkbzFBSDdnUzl6ZHp6eXJDQWw4SXJpMFR0VVU0TU4K';

/** Tauri wraps a minisign key or signature file in base64; the second line holds the bytes. */
function payload(encoded: string): Buffer {
  const line = Buffer.from(encoded, 'base64').toString('utf8').split('\n')[1] ?? '';
  return Buffer.from(line.trim(), 'base64');
}

/** Whether `signature` (a Tauri updater `.sig`) signs `data` with `publicKey`. */
export function verifyMinisign(data: Buffer, signature: string, publicKey: string): boolean {
  const key = payload(publicKey); // "Ed", key id (8), Ed25519 key (32)
  const signed = payload(signature); // algorithm (2), key id (8), Ed25519 signature (64)
  if (key.length !== 42 || signed.length !== 74) return false;
  // Tauri always signs the file's BLAKE2b-512 hash ("ED"), never the legacy raw form.
  if (signed.subarray(0, 2).toString('latin1') !== 'ED') return false;
  if (!signed.subarray(2, 10).equals(key.subarray(2, 10))) return false;
  const ed25519 = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: key.subarray(10).toString('base64url') },
    format: 'jwk',
  });
  return verify(null, createHash('blake2b512').update(data).digest(), ed25519, signed.subarray(10));
}
