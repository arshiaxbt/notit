/**
 * Sends Lab jobs to a Web Worker and returns promises. If workers are not
 * available (or the worker fails to start) the job runs on the main thread
 * after yielding once, so the page can still paint its "running" state.
 */
import { runJob } from './jobs';
import type { Job, JobResults } from './jobs';
import type { WorkerRequest, WorkerResponse } from './worker';

let worker: Worker | null = null;
let workerBroken = false;
let nextId = 1;
const waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; job: Job }>();

function runInline(job: Job): Promise<unknown> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(runJob(job as never));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    }, 0);
  });
}

function getWorker(): Worker | null {
  if (workerBroken || typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const entry = waiting.get(e.data.id);
      if (!entry) return;
      waiting.delete(e.data.id);
      if (e.data.ok) entry.resolve(e.data.result);
      else entry.reject(new Error(e.data.error));
    };
    worker.onerror = () => {
      // The worker could not start: finish everything that is waiting on the main thread.
      workerBroken = true;
      worker = null;
      for (const [id, entry] of waiting) {
        waiting.delete(id);
        runInline(entry.job).then(entry.resolve, entry.reject);
      }
    };
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

export function runInBackground<K extends Job['kind']>(job: Extract<Job, { kind: K }>): Promise<JobResults[K]> {
  const w = getWorker();
  if (!w) return runInline(job) as Promise<JobResults[K]>;
  return new Promise<JobResults[K]>((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, job });
    const request: WorkerRequest = { id, job };
    w.postMessage(request);
  });
}
