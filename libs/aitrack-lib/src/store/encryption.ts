import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

import { isRecord } from '../data/guards.js';

export const ENCRYPTION_PASSPHRASE_ENV = 'AITRACK_ENCRYPTION_PASSPHRASE';

const FORMAT = 'aitrack-aes-256-gcm-scrypt-v1';
// Above any real schema version, so an older aitrack skips the file with "upgrade aitrack".
const ENVELOPE_SCHEMA_VERSION = 99;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface EncryptedEnvelope {
  schemaVersion: number;
  encrypted: string;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

/** Empty counts as unset; unlike other variables the value is not trimmed. */
export function encryptionPassphrase(): string | undefined {
  const value = process.env[ENCRYPTION_PASSPHRASE_ENV];
  return value === undefined || value === '' ? undefined : value;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_BYTES, SCRYPT);
}

export function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  return isRecord(value) && typeof value.encrypted === 'string' && value.encrypted.length > 0;
}

/** Whether raw file contents are an encrypted envelope. */
export function isEncryptedRaw(raw: string): boolean {
  try {
    return isEncryptedEnvelope(JSON.parse(raw));
  } catch {
    return false;
  }
}

export function encryptText(plaintext: string, passphrase: string): string {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  cipher.setAAD(Buffer.from(FORMAT));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const envelope: EncryptedEnvelope = {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    encrypted: FORMAT,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
  return JSON.stringify(envelope, null, 2);
}

function decodeField(value: unknown, bytes?: number): Buffer {
  const decoded = typeof value === 'string' ? Buffer.from(value, 'base64') : Buffer.alloc(0);
  if (decoded.length === 0 || (bytes !== undefined && decoded.length !== bytes)) {
    throw new Error('malformed encryption envelope');
  }
  return decoded;
}

/** Throws on an unknown format, a malformed field, or failed authentication (wrong passphrase or tampering). */
export function decryptEnvelope(envelope: EncryptedEnvelope, passphrase: string): string {
  if (envelope.encrypted !== FORMAT) {
    throw new Error(`unsupported encryption format "${envelope.encrypted}"; upgrade aitrack`);
  }
  const salt = decodeField(envelope.salt, SALT_BYTES);
  const iv = decodeField(envelope.iv, IV_BYTES);
  const tag = decodeField(envelope.tag, TAG_BYTES);
  const data = decodeField(envelope.data);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  decipher.setAAD(Buffer.from(FORMAT));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('authentication failed');
  }
}
