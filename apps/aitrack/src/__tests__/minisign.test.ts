import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { OPENTRACK_PUBLIC_KEY, verifyMinisign } from '../minisign.js';

// `tauri signer sign` output for "hello opentrack\n" with opentrack's release key.
const SAMPLE = Buffer.from('hello opentrack\n');
const SAMPLE_SIGNATURE =
  'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUQjJxRzZkNTRadk1IOEN3WUd1QXN6RkZsc2VERms1VFhpSERSM1Y4THYvdzlQakxMR0RGZmxHL2JEaGpVeXgxa1NhMHh4aWI1Qy9SNUp4VEo2UnVYdFRuMXUxMXpvUFFvPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkxMzEzNjU5CWZpbGU6c2FtcGxlLnR4dApjY2VCV0FvMkpIZGF1eFg1blNMMXV3Q2pFaTZYeGx6K1Z0dmZmdjk2UUxyNHFzWk1RWmtCRWt2L3dleGNsUExwT1dRcjNnbWZVZ01GZjVuK2hvd2dBUT09Cg==';

describe('minisign', () => {
  it('uses the key the desktop updater trusts', () => {
    const config = JSON.parse(
      readFileSync(new URL('../../../opentrack/tauri.conf.json', import.meta.url), 'utf8'),
    ) as { plugins: { updater: { pubkey: string } } };
    expect(config.plugins.updater.pubkey).toBe(OPENTRACK_PUBLIC_KEY);
  });

  it('accepts a Tauri signature and rejects altered files, signatures and keys', () => {
    expect(verifyMinisign(SAMPLE, SAMPLE_SIGNATURE, OPENTRACK_PUBLIC_KEY)).toBe(true);
    expect(
      verifyMinisign(Buffer.from('hello opentrack!\n'), SAMPLE_SIGNATURE, OPENTRACK_PUBLIC_KEY),
    ).toBe(false);
    expect(verifyMinisign(SAMPLE, 'garbage', OPENTRACK_PUBLIC_KEY)).toBe(false);
    const otherKeyId = Buffer.from(OPENTRACK_PUBLIC_KEY, 'base64')
      .toString('utf8')
      .replace('RWTB2qG6', 'RWTA2qG6');
    expect(
      verifyMinisign(SAMPLE, SAMPLE_SIGNATURE, Buffer.from(otherKeyId).toString('base64')),
    ).toBe(false);
  });
});
