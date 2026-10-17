import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loggedOutput, makeMachineFile, makeProviderDay } from '@aitrack/test-fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkRawMachineFile } from '../../data/validate.js';
import { decryptEnvelope, type EncryptedEnvelope, encryptText } from '../encryption.js';
import { readDataFile, serializeMachineFile } from '../machineFiles.js';

const machine = makeMachineFile('laptop', {
  '2026-01-15': { claude_code: makeProviderDay(100, 50, 1.25, 'claude-sonnet-4') },
});
const PASSPHRASE = 'correct horse battery staple';

function envelopeOf(text: string): EncryptedEnvelope {
  return JSON.parse(text) as EncryptedEnvelope;
}

describe('encryption', () => {
  it('round-trips and uses a fresh salt and IV per file', () => {
    const first = encryptText('secret usage', PASSPHRASE);
    const second = encryptText('secret usage', PASSPHRASE);

    expect(first).not.toContain('secret usage');
    expect(decryptEnvelope(envelopeOf(first), PASSPHRASE)).toBe('secret usage');
    expect(envelopeOf(first).salt).not.toBe(envelopeOf(second).salt);
    expect(envelopeOf(first).iv).not.toBe(envelopeOf(second).iv);
  });

  it('rejects a wrong passphrase and every tampered field', () => {
    const envelope = envelopeOf(encryptText('secret usage', PASSPHRASE));

    expect(() => decryptEnvelope(envelope, 'wrong')).toThrow('authentication failed');
    for (const field of ['data', 'tag', 'iv', 'salt'] as const) {
      const bytes = Buffer.from(envelope[field], 'base64');
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      const tampered = { ...envelope, [field]: bytes.toString('base64') };
      expect(() => decryptEnvelope(tampered, PASSPHRASE)).toThrow('authentication failed');
    }
  });
});

describe('encrypted machine files', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aitrack-enc-'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('reads encrypted and plain files together, skipping unreadable ones with the fix named', () => {
    const plain = join(dir, 'plain.json');
    const encrypted = join(dir, 'encrypted.json');
    writeFileSync(plain, serializeMachineFile(machine, false));
    vi.stubEnv('AITRACK_ENCRYPTION_PASSPHRASE', PASSPHRASE);
    writeFileSync(encrypted, serializeMachineFile(machine, true));

    expect(readDataFile(encrypted)).toEqual(machine);
    expect(readDataFile(plain)).toEqual(machine);

    vi.stubEnv('AITRACK_ENCRYPTION_PASSPHRASE', '');
    expect(readDataFile(plain)).toEqual(machine);
    expect(readDataFile(encrypted)).toBeNull();
    expect(loggedOutput('warn')).toContain(encrypted);
    expect(loggedOutput('warn')).toContain('set AITRACK_ENCRYPTION_PASSPHRASE');

    vi.stubEnv('AITRACK_ENCRYPTION_PASSPHRASE', 'wrong');
    expect(readDataFile(encrypted)).toBeNull();
    expect(loggedOutput('warn')).toContain('could not be decrypted');
  });

  it('refuses to write encrypted without a passphrase', () => {
    vi.stubEnv('AITRACK_ENCRYPTION_PASSPHRASE', '');
    expect(() => serializeMachineFile(machine, true)).toThrow('AITRACK_ENCRYPTION_PASSPHRASE');
  });

  it('carries a schemaVersion that older aitrack versions report as needing an upgrade', () => {
    const envelope = envelopeOf(encryptText(JSON.stringify(machine), PASSPHRASE));
    const { encrypted: _marker, ...asPlain } = envelope;

    expect(checkRawMachineFile(JSON.stringify(asPlain), 'f.json').diagnostics[0]).toMatchObject({
      reason: expect.stringContaining('upgrade aitrack') as unknown,
    });
  });
});
