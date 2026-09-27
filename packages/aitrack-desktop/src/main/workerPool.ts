import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, type WorkerOptions } from 'node:worker_threads';

import { isRecord } from 'aitrack-lib/data/guards';
import type { DayMap } from 'aitrack-lib/data/types';
import type { Session, SessionSignals } from 'aitrack-lib/sessions/index';

export type ReaderProvider = 'claude' | 'codex' | 'cursor';

export interface FileUsage {
  days: DayMap;
  keys: string[];
}

export interface ReadResult {
  session: Session;
  signals: SessionSignals;
  usage: FileUsage | null;
}

interface Job {
  id: number;
  provider: ReaderProvider;
  file: string;
  resolve: (result: ReadResult) => void;
  reject: (error: Error) => void;
}

type WorkerResult =
  | { id: number; ok: true; session: Session; signals: SessionSignals; usage?: unknown }
  | { id: number; ok: false; error: string };

function moduleWorkerOptions(): WorkerOptions {
  const options: WorkerOptions = {};
  Object.assign(options, { type: 'module' });
  return options;
}

export function readerPoolSize(): number {
  return Math.max(1, Math.min(4, availableParallelism() - 1));
}

export function readerWorkerPath(): string {
  if (typeof process.resourcesPath === 'string') {
    const unpacked = join(
      process.resourcesPath,
      'app.asar.unpacked',
      'out',
      'main',
      'ingestWorker.js',
    );
    if (existsSync(unpacked)) return unpacked;
  }
  const built = join(import.meta.dirname, 'ingestWorker.js');
  if (existsSync(built)) return built;
  return fileURLToPath(new URL('./ingestWorker.ts', import.meta.url));
}

export class ReaderPool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: Job[] = [];
  private readonly pending = new Map<number, Job>();
  private readonly assigned = new Map<Worker, number>();
  private nextId = 1;

  constructor() {
    for (let index = 0; index < readerPoolSize(); index += 1) {
      const worker = new Worker(readerWorkerPath(), moduleWorkerOptions());
      worker.on('message', (message: unknown) => {
        this.finish(message);
      });
      worker.on('error', (error: unknown) => {
        const failure = error instanceof Error ? error : new Error('Reader failed');
        this.fail(worker, failure);
        this.abandon(failure);
      });
      this.workers.push(worker);
      this.idle.push(worker);
    }
  }

  read(provider: ReaderProvider, file: string): Promise<ReadResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId, provider, file, resolve, reject });
      this.nextId += 1;
      this.pump();
    });
  }

  async close(): Promise<void> {
    const error = new Error('Reader pool closed');
    for (const job of this.queue) job.reject(error);
    for (const job of this.pending.values()) job.reject(error);
    this.queue.length = 0;
    this.pending.clear();
    await Promise.all(this.workers.map((worker) => worker.terminate()));
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.shift();
      const job = this.queue.shift();
      if (worker === undefined || job === undefined) return;
      this.pending.set(job.id, job);
      this.assigned.set(worker, job.id);
      worker.postMessage({ id: job.id, provider: job.provider, file: job.file });
    }
  }

  private finish(message: unknown): void {
    if (!isWorkerResult(message)) return;
    const job = this.pending.get(message.id);
    this.pending.delete(message.id);
    const worker = workerFor(this.assigned, message.id);
    if (worker !== undefined) {
      this.assigned.delete(worker);
      this.idle.push(worker);
    }
    if (job !== undefined) {
      if (message.ok) {
        job.resolve({
          session: message.session,
          signals: message.signals,
          usage: fileUsage(message.usage),
        });
      } else job.reject(new Error(message.error));
    }
    this.pump();
  }

  private abandon(error: Error): void {
    if (this.idle.length > 0 || this.assigned.size > 0) return;
    for (const job of this.queue) job.reject(error);
    this.queue.length = 0;
  }

  private fail(worker: Worker, error: Error): void {
    const id = this.assigned.get(worker);
    if (id !== undefined) {
      this.pending.get(id)?.reject(error);
      this.pending.delete(id);
      this.assigned.delete(worker);
    }
    const idleAt = this.idle.indexOf(worker);
    if (idleAt !== -1) this.idle.splice(idleAt, 1);
  }
}

function workerFor(assigned: Map<Worker, number>, id: number): Worker | undefined {
  for (const [worker, jobId] of assigned) {
    if (jobId === id) return worker;
  }
  return undefined;
}

function fileUsage(value: unknown): FileUsage | null {
  if (!isRecord(value) || !(value.days instanceof Map) || !Array.isArray(value.keys)) return null;
  const keys = value.keys.filter((key): key is string => typeof key === 'string');
  return { days: value.days as DayMap, keys };
}

function isWorkerResult(value: unknown): value is WorkerResult {
  if (!isRecord(value) || typeof value.id !== 'number' || typeof value.ok !== 'boolean') {
    return false;
  }
  if (value.ok) return isRecord(value.session) && isRecord(value.signals);
  return typeof value.error === 'string';
}
