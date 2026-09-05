import { Buffer } from 'node:buffer';

const MAX_FILENAME_BYTES = 255;
const INVALID_FILENAME_CHARACTERS = new Set('<>:"/\\|?*');
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

function hasInvalidFilenameCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (INVALID_FILENAME_CHARACTERS.has(character) || (codePoint !== undefined && codePoint < 32)) {
      return true;
    }
  }
  return false;
}

export function machineIdValidationError(value: string): string | null {
  const machineId = value.trim();
  if (machineId.length === 0) return 'Machine name is required';
  if (machineId === '.' || machineId === '..') {
    return 'Machine name must not be "." or ".."';
  }
  if (hasInvalidFilenameCharacter(machineId)) {
    return 'Machine name contains characters that are not safe in a filename';
  }
  if (machineId.endsWith('.')) {
    return 'Machine name must not end with a period';
  }
  if (WINDOWS_RESERVED_NAME.test(machineId)) {
    return 'Machine name is reserved by the operating system';
  }
  if (Buffer.byteLength(`${machineId}.json`, 'utf8') > MAX_FILENAME_BYTES) {
    return 'Machine name is too long';
  }
  return null;
}

export function normalizeMachineId(value: string): string {
  const error = machineIdValidationError(value);
  if (error) throw new Error(error);
  return value.trim();
}

export function machineDataFilename(machineId: string): string {
  return `${normalizeMachineId(machineId)}.json`;
}
