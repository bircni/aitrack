import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256File(path: string): string {
  return sha256(readFileSync(path));
}

export function versionFromTag(tag: string): string {
  return tag.replace(/^v/u, '');
}
