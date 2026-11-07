import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { scanClaudeFile } from './claudeScan.js';
import { scanCodexFile } from './codexScan.js';
import { DEFAULT_CONCURRENCY } from './concurrency.js';

const SCANNERS = { claude: scanClaudeFile, codex: scanCodexFile };

export type ScanKind = keyof typeof SCANNERS;
export type ScanResult<K extends ScanKind> = Awaited<ReturnType<(typeof SCANNERS)[K]>>;

/** A worker per this much work: below it, starting one costs more than it saves. */
const BYTES_PER_WORKER = 24 * 1024 * 1024;
/** The main thread prices and caches every result, so more workers add CPU and memory, not speed. */
const MAX_WORKERS = 4;
/** Two per worker, so one file's read overlaps another's parse. */
const JOBS_PER_WORKER = 2;

export interface ScanRequest {
  id: number;
  kind: ScanKind;
  filePath: string;
}

type ScanReply = { id: number; result: unknown } | { id: number; error: unknown };

export async function answerScan({ id, kind, filePath }: ScanRequest): Promise<ScanReply> {
  try {
    return { id, result: await SCANNERS[kind](filePath) };
  } catch (error) {
    return { id, error };
  }
}

interface Job {
  request: ScanRequest;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
}

async function runInThread(job: Job): Promise<void> {
  const reply = await answerScan(job.request);
  if ('error' in reply) job.reject(reply.error);
  else job.resolve(reply.result);
}

export class ScanPool {
  private readonly queue: Job[] = [];
  private readonly running = new Map<Worker, Map<number, Job>>();
  private inThread = 0;
  private isBroken = false;
  private nextId = 0;

  constructor(
    private readonly url: URL,
    size: number,
  ) {
    this.grow(size);
  }

  /** A later batch may need more workers than the one that started the pool. */
  grow(size: number): void {
    while (!this.isBroken && this.running.size < size) this.start();
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
    this.pump();
    return Promise.all(workers.map((worker) => worker.terminate()));
  }

  private start(): void {
    let worker: Worker;
    try {
      worker = new Worker(this.url);
    } catch {
      this.isBroken = true; // Refused outright, for one, under the permission model.
      return;
    }
    this.running.set(worker, new Map());
    worker.on('message', (reply: ScanReply) => {
      this.settle(worker, reply);
    });
    const abandon = () => {
      this.abandon(worker);
    };
    worker.on('error', abandon);
    worker.on('messageerror', abandon);
    worker.on('exit', abandon); // Without an error too, and this runs after `close` as a no-op.
  }

  private pump(): void {
    if (this.running.size === 0) {
      this.pumpInThread();
      return;
    }
    for (const [worker, jobs] of this.running) {
      while (jobs.size < JOBS_PER_WORKER) {
        const job = this.queue.shift();
        if (!job) return;
        jobs.set(job.request.id, job);
        worker.postMessage(job.request);
      }
    }
  }

  /** With no worker left, the same limit on open files as any in-thread read. */
  private pumpInThread(): void {
    while (this.inThread < DEFAULT_CONCURRENCY) {
      const job = this.queue.shift();
      if (!job) return;
      this.inThread++;
      void runInThread(job).finally(() => {
        this.inThread--;
        this.pump();
      });
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

  /** A worker that fails to start, crashes or exits hands its files back. */
  private abandon(worker: Worker): void {
    const jobs = this.running.get(worker);
    if (!jobs) return;
    this.running.delete(worker);
    this.isBroken = true;
    void worker.terminate();
    this.queue.unshift(...jobs.values());
    this.pump();
  }
}

/**
 * The worker file beside this module, if there is one. A bundle has none, and
 * only a dedicated file keeps a worker from re-running a bundling app's top level.
 */
export function scanWorkerEntry(moduleUrl: unknown = import.meta.url): URL | undefined {
  if (typeof moduleUrl !== 'string' || !moduleUrl.startsWith('file:')) return undefined;
  const entry = new URL('./scanWorker.js', moduleUrl);
  return existsSync(fileURLToPath(entry)) ? entry : undefined;
}

function workerCount(files: number, totalBytes: number): number {
  return Math.min(
    availableParallelism(),
    MAX_WORKERS,
    files,
    Math.floor(totalBytes / BYTES_PER_WORKER),
  );
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
  entry = scanWorkerEntry(),
): Array<{ source: T; scan: () => Promise<ScanResult<K>> }> {
  const workers = workerCount(sources.length, totalBytes);
  if (entry === undefined || workers < 2) {
    const scanner = SCANNERS[kind] as (filePath: string) => Promise<ScanResult<K>>;
    return sources.map((source) => ({ source, scan: () => scanner(source.filePath) }));
  }

  shared ??= { pool: new ScanPool(entry, 0), users: 0 };
  const current = shared;
  current.users++;
  current.pool.grow(workers);
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
