/// <reference lib="webworker" />
/** Runs Lab jobs off the main thread so sliders stay responsive. */
import { runJob } from './jobs';
import type { Job } from './jobs';

export interface WorkerRequest {
  id: number;
  job: Job;
}

export type WorkerResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { id, job } = e.data;
  let response: WorkerResponse;
  try {
    response = { id, ok: true, result: runJob(job) };
  } catch (err) {
    response = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  (self as DedicatedWorkerGlobalScope).postMessage(response);
};
