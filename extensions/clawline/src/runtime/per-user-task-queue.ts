import { AsyncLocalStorage } from "node:async_hooks";

export type PerUserTaskScope = {
  userId: string;
  streamKey?: string;
};

export function resolvePerUserTaskQueueKey(scope: PerUserTaskScope): string {
  const streamKey = scope.streamKey?.trim();
  if (!streamKey) {
    return scope.userId;
  }
  return `${scope.userId}::${streamKey.toLowerCase()}`;
}

export function createPerUserTaskQueue(params?: {
  resolveQueueKey?: (scope: PerUserTaskScope) => string;
  onTaskError?: (err: unknown) => void;
}) {
  const queue = new Map<string, Promise<unknown>>();
  const context = new AsyncLocalStorage<string>();
  const resolveQueueKey = params?.resolveQueueKey ?? resolvePerUserTaskQueueKey;
  const onTaskError = params?.onTaskError;

  function run<T>(scope: PerUserTaskScope, task: () => Promise<T>): Promise<T> {
    const queueKey = resolveQueueKey(scope);
    if (context.getStore() === queueKey) {
      return task();
    }
    const previous = queue.get(queueKey) ?? Promise.resolve();
    const next = previous
      .catch((err) => {
        onTaskError?.(err);
      })
      .then(() => context.run(queueKey, task))
      .finally(() => {
        if (queue.get(queueKey) === next) {
          queue.delete(queueKey);
        }
      });
    queue.set(queueKey, next);
    return next;
  }

  async function drain() {
    await Promise.allSettled(Array.from(queue.values()));
  }

  return {
    run,
    drain,
  };
}
