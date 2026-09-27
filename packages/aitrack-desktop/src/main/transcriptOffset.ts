import { open } from 'node:fs/promises';

const CHUNK = 64 * 1024;

/** Byte index just after the last complete line, or 0 when the file has no newline. */
export async function completeLineOffset(filePath: string): Promise<number> {
  const handle = await open(filePath, 'r');
  try {
    const info = await handle.stat();
    let end = info.size;
    while (end > 0) {
      const start = Math.max(0, end - CHUNK);
      const length = end - start;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      const newline = buffer.lastIndexOf(0x0a);
      if (newline !== -1) return start + newline + 1;
      end = start;
    }
    return 0;
  } finally {
    await handle.close();
  }
}

/** Whether bytes at and after `offset` contain a finished line. */
export async function tailHasCompleteLine(filePath: string, offset: number): Promise<boolean> {
  const handle = await open(filePath, 'r');
  try {
    const info = await handle.stat();
    let position = offset;
    while (position < info.size) {
      const length = Math.min(info.size - position, CHUNK);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, position);
      if (buffer.includes(0x0a)) return true;
      position += length;
    }
    return false;
  } finally {
    await handle.close();
  }
}
