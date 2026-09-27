import { parentPort } from 'node:worker_threads';

import {
  readClaudeSessionFile,
  readCodexSessionFile,
  readCursorSessionFile,
} from 'aitrack-lib/sessions/index';

interface ReadRequest {
  id: number;
  provider: 'claude' | 'codex' | 'cursor';
  file: string;
}

const port = parentPort;
if (port === null) {
  throw new Error('The transcript reader must run as a worker.');
}

port.on('message', (request: ReadRequest) => {
  void readRequest(port, request);
});

async function readRequest(
  channel: NonNullable<typeof parentPort>,
  request: ReadRequest,
): Promise<void> {
  try {
    const result = await readFile(request);
    channel.postMessage({ id: request.id, ok: true, ...result });
  } catch (error) {
    channel.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : 'unreadable transcript',
    });
  }
}

async function readFile(request: ReadRequest): Promise<{
  session: Awaited<ReturnType<typeof readClaudeSessionFile>>['session'];
  signals: Awaited<ReturnType<typeof readClaudeSessionFile>>['signals'];
}> {
  switch (request.provider) {
    case 'claude': {
      const result = await readClaudeSessionFile(request.file);
      return result;
    }
    case 'codex': {
      const result = await readCodexSessionFile(request.file);
      return result;
    }
    case 'cursor': {
      const result = await readCursorSessionFile(request.file);
      return result;
    }
    default: {
      const unknown: never = request.provider;
      throw new Error(String(unknown));
    }
  }
}
