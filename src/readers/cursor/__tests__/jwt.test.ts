import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { decodeJwtPayload } from '../jwt.js';

function token(payload: unknown, { urlSafe = false } = {}): string {
  let encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64').replace(/=+$/u, '');
  if (urlSafe) encoded = encoded.replaceAll('+', '-').replaceAll('/', '_');
  return `header.${encoded}.signature`;
}

describe('decodeJwtPayload', () => {
  it('reads the subject out of a well-formed token', () => {
    expect(decodeJwtPayload(token({ sub: 'user_123' }))?.sub).toBe('user_123');
  });

  it('accepts base64url padding and alphabet', () => {
    // JWTs are base64url and unpadded; decoding them as plain base64 without
    // restoring both would silently mangle the payload.
    const payload = { sub: 'user_>>>???_with_padding_needs' };
    expect(decodeJwtPayload(token(payload, { urlSafe: true }))?.sub).toBe(payload.sub);
  });

  it('returns null rather than throwing on anything malformed', () => {
    // This is a token read off disk from another program; it is untrusted.
    expect(decodeJwtPayload('')).toBeNull();
    expect(decodeJwtPayload('nodots')).toBeNull();
    expect(decodeJwtPayload('header..signature')).toBeNull();
    expect(decodeJwtPayload('header.!!!not-base64!!!.signature')).toBeNull();
    expect(decodeJwtPayload(`header.${Buffer.from('not json').toString('base64')}.sig`)).toBeNull();
  });

  it('returns a payload with no subject when the token omits one', () => {
    expect(decodeJwtPayload(token({ iss: 'cursor' }))?.sub).toBeUndefined();
  });
});
