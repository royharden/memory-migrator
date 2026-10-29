import type { ExtractResponse, InventoryResponse, WorkerRequest, WorkerResponse } from "./protocol.ts";

/**
 * One worker per operation so Cancel can terminate it outright (JSON.parse is not
 * interruptible any other way). Terminating also releases its raw/parsed buffers.
 */
export interface RunningJob<T> {
  promise: Promise<T>;
  cancel: () => void;
}

export function runWorker(request: Extract<WorkerRequest, { type: "inventory" }>): RunningJob<InventoryResponse>;
export function runWorker(request: Extract<WorkerRequest, { type: "extract" }>): RunningJob<ExtractResponse>;
export function runWorker(request: WorkerRequest): RunningJob<InventoryResponse | ExtractResponse> {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const holder: { reject?: (error: Error) => void } = {};
  const promise = new Promise<InventoryResponse | ExtractResponse>((resolve, reject) => {
    holder.reject = reject;
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      worker.terminate();
      const data = event.data;
      if (data.type === "error") reject(new Error(data.message));
      else resolve(data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "The import worker crashed."));
    };
  });
  worker.postMessage(request);
  return {
    promise,
    cancel: () => {
      worker.terminate();
      holder.reject?.(new Error("Cancelled."));
    },
  };
}
