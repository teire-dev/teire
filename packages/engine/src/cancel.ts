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

/**
 * Work shared between runs (a sandbox image build several runs wait on) runs outside any run's
 * cancel scope (U2 review): one run's cancel must not stop what others are waiting for.
 */
export function withoutCancel<T>(work: () => Promise<T>): Promise<T> {
  return scope.exit(work);
}

/** A shared promise this run stops waiting for when it is cancelled; the work itself goes on. */
export function untilCancelled<T>(work: Promise<T>): Promise<T> {
  const signal = scope.getStore();
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(new RunCancelledError());
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new RunCancelledError());
    signal.addEventListener("abort", stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}
