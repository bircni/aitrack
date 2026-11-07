import type { EventEmitter } from 'node:events';

import { providerFixture } from '@aitrack/test-fixtures';
import { expect, it, vi } from 'vitest';

const port = vi.hoisted(() => ({
  current: undefined as (EventEmitter & { postMessage: unknown }) | undefined,
}));

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  const { EventEmitter: Emitter } = await import('node:events');
  port.current = Object.assign(new Emitter(), { postMessage: vi.fn() });
  return { ...actual, parentPort: port.current };
});

import { scanClaudeFile } from '../claudeScan.js';

// The real-thread round trip in scanPool.test.ts runs outside coverage instrumentation.
it('answers each request on the parent port', async () => {
  await import('../scanWorker.js');
  const filePath = providerFixture('claude-session.jsonl');
  port.current?.emit('message', { id: 7, kind: 'claude', filePath });
  await vi.waitFor(() => {
    expect(port.current?.postMessage).toHaveBeenCalledOnce();
  });
  expect(port.current?.postMessage).toHaveBeenCalledWith({
    id: 7,
    result: await scanClaudeFile(filePath),
  });
});
