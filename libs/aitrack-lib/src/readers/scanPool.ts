import { availableParallelism } from 'node:os';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

import { scanClaudeFile } from './claudeScan.js';
import { scanCodexFile } from './codexScan.js';

const SCANNERS = { claude: scanClaudeFile, codex: scanCodexFile };

export type ScanKind = keyof typeof SCANNERS;
export type ScanResult<K extends ScanKind> = Awaited<ReturnType<(typeof SCANNERS)[K]>>;

/** Below this, starting workers costs more than it saves. */
const MIN_WORKER_BYTES = 32 * 1024 * 1024;
const MAX_WORKERS = 8;
/** Two per worker, so one file's read overlaps another's parse. */
const JOBS_PER_WORKER = 2;
const WORKER_DATA = 'aitrack-scan-worker';

interface ScanRequest {
  id: number;
  kind: ScanKind;
  filePath: string;
}

type ScanReply = { id: number; result: unknown } | { id: number; error: unknown };

async function answerScan({ id, kind, filePath }: ScanRequest): Promise<ScanReply> {
  try {
    return { id, result: await SCANNERS[kind](filePath) };
  } catch (error) {
    return { id, error };
  }
}

if (!isMainThread && workerData === WORKER_DATA) {
  parentPort?.on('message', (request: ScanRequest) => {
    void answerScan(request).then((reply) => parentPort?.postMessage(reply));
  });
}

interface Job {
  request: ScanRequest;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
}

function runInThread(job: Job): void {
  answerScan(job.request).then((reply) => {
    if ('error' in reply) job.reject(reply.error);
    else job.resolve(reply.result);
  }, job.reject);
}

export class ScanPool {
  private readonly queue: Job[] = [];
  private readonly running = new Map<Worker, Map<number, Job>>();
  private nextId = 0;

  constructor(url: URL, size: number) {
    for (let index = 0; index < size; index++) {
      const worker = new Worker(url, { workerData: WORKER_DATA });
      this.running.set(worker, new Map());
      worker.on('message', (reply: ScanReply) => {
        this.settle(worker, reply);
      });
      worker.on('error', () => {
        this.abandon(worker);
      });
    }
  }

  scan<K extends ScanKind>(kind: K, filePath: string): Promise<ScanResult<K>> {
    return new Promise((resolve, reject) => {
      const request = { id: this.nextId++, kind, filePath };
      this.queue.push({ request, resolve: resolve as Job['resolve'], reject });
      this.pump();
    });
  }

  close(): Promise<unknown> {
    const workers = [...this.running.keys()];
    this.running.clear();
    for (const job of this.queue.splice(0)) runInThread(job);
    return Promise.all(workers.map((worker) => worker.terminate()));
  }

  private pump(): void {
    for (const [worker, jobs] of this.running) {
      while (jobs.size < JOBS_PER_WORKER) {
        const job = this.queue.shift();
        if (!job) return;
        jobs.set(job.request.id, job);
        worker.postMessage(job.request);
      }
    }
  }

  private settle(worker: Worker, reply: ScanReply): void {
    const jobs = this.running.get(worker);
    const job = jobs?.get(reply.id);
    if (!jobs || !job) return;
    jobs.delete(reply.id);
    if ('error' in reply) job.reject(reply.error);
    else job.resolve(reply.result);
    this.pump();
  }

  /** A worker that fails to start or crashes hands its files back to this thread. */
  private abandon(worker: Worker): void {
    const jobs = this.running.get(worker);
    if (!jobs) return;
    this.running.delete(worker);
    void worker.terminate();
    for (const job of jobs.values()) runInThread(job);
    if (this.running.size === 0) for (const job of this.queue.splice(0)) runInThread(job);
    else this.pump();
  }
}

/** This module as a worker entry; not when bundled into CommonJS or run from TypeScript sources. */
function workerUrl(): URL | undefined {
  const url: unknown = import.meta.url;
  return typeof url === 'string' && url.endsWith('.js') ? new URL(url) : undefined;
}

let shared: { pool: ScanPool; users: number } | undefined;

/**
 * A scan per source, as a thunk so an in-thread scan starts only when awaited.
 * A large enough batch is spread over worker threads, shared by readers that run at once.
 */
export function scanEach<K extends ScanKind, T extends { filePath: string }>(
  kind: K,
  sources: T[],
  totalBytes: number,
  entry = workerUrl(),
): Array<{ source: T; scan: () => Promise<ScanResult<K>> }> {
  const url = sources.length > 1 && totalBytes >= MIN_WORKER_BYTES ? entry : undefined;
  if (url === undefined) {
    const scanner = SCANNERS[kind] as (filePath: string) => Promise<ScanResult<K>>;
    return sources.map((source) => ({ source, scan: () => scanner(source.filePath) }));
  }

  shared ??= {
    pool: new ScanPool(url, Math.min(availableParallelism(), MAX_WORKERS)),
    users: 0,
  };
  const current = shared;
  current.users++;
  const pending = sources.map((source) => ({
    source,
    promise: current.pool.scan(kind, source.filePath),
  }));
  void Promise.allSettled(pending.map(({ promise }) => promise)).then(() => {
    if (--current.users > 0) return;
    if (shared === current) shared = undefined;
    return current.pool.close();
  });
  return pending.map(({ source, promise }) => ({ source, scan: () => promise }));
}
