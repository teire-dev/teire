import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A run's cancel signal (U1, "Cancel is honest"): the worker runs the engine's work inside
 * `withCancel(signal, …)`, and every model call, resolver job and sandbox wait below reads it here
 * instead of having the signal threaded through each call.
 */
const scope = new AsyncLocalStorage<AbortSignal>();

export class RunCancelledError extends Error {
  constructor(message = "the run was cancelled") {
    super(message);
  }
}

export function withCancel<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return scope.run(signal, work);
}

/** The current run's signal, if the work runs inside `withCancel`. */
export function cancelSignal(): AbortSignal | undefined {
  return scope.getStore();
}

/** Stops here when the run was cancelled (a checkpoint between steps). */
export function throwIfCancelled() {
  if (scope.getStore()?.aborted) throw new RunCancelledError();
}
