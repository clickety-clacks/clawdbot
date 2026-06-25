import { AsyncLocalStorage } from "node:async_hooks";

export type PerUserTaskScope = {
  userId: string;
  streamKey?: string;
};

export type ClawlineProviderLane = "prompt" | "control" | "local" | "interactive-callback";

export type ProviderLaneAdmissionScope = PerUserTaskScope & {
  lane: ClawlineProviderLane;
};

export type ProviderPromptTurnScope = PerUserTaskScope & {
  streamKey: string;
};

export function resolvePerUserTaskQueueKey(scope: PerUserTaskScope): string {
  const streamKey = scope.streamKey?.trim();
  if (!streamKey) {
    return scope.userId;
  }
  return `${scope.userId}::${streamKey.toLowerCase()}`;
}

export function resolveProviderLaneAdmissionQueueKey(scope: ProviderLaneAdmissionScope): string {
  return `${scope.userId}::${scope.lane}`;
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

export function createClawlineProviderLaneQueue(params?: {
  resolveAdmissionQueueKey?: (scope: ProviderLaneAdmissionScope) => string;
  resolvePromptTurnQueueKey?: (scope: ProviderPromptTurnScope) => string;
  onTaskError?: (err: unknown) => void;
}) {
  const admissionQueue = createPerUserTaskQueue({
    resolveQueueKey: (scope) =>
      (params?.resolveAdmissionQueueKey ?? resolveProviderLaneAdmissionQueueKey)(
        scope as ProviderLaneAdmissionScope,
      ),
    onTaskError: params?.onTaskError,
  });
  const promptTurnQueue = createPerUserTaskQueue({
    resolveQueueKey: (scope) =>
      (params?.resolvePromptTurnQueueKey ?? resolvePerUserTaskQueueKey)(
        scope as ProviderPromptTurnScope,
      ),
    onTaskError: params?.onTaskError,
  });

  function runAdmission<T>(scope: ProviderLaneAdmissionScope, task: () => Promise<T>): Promise<T> {
    return admissionQueue.run(scope, task);
  }

  function runPromptAdmission<T>(scope: PerUserTaskScope, task: () => Promise<T>): Promise<T> {
    return runAdmission({ ...scope, lane: "prompt" }, task);
  }

  function runControl<T>(scope: PerUserTaskScope, task: () => Promise<T>): Promise<T> {
    return runAdmission({ ...scope, lane: "control" }, task);
  }

  function runLocal<T>(scope: PerUserTaskScope, task: () => Promise<T>): Promise<T> {
    return runAdmission({ ...scope, lane: "local" }, task);
  }

  function runInteractiveCallback<T>(scope: PerUserTaskScope, task: () => Promise<T>): Promise<T> {
    return runAdmission({ ...scope, lane: "interactive-callback" }, task);
  }

  function runPromptTurn<T>(scope: ProviderPromptTurnScope, task: () => Promise<T>): Promise<T> {
    return promptTurnQueue.run(scope, task);
  }

  async function runPromptTurnAfterAdmission<TPrepared, TResult>(
    scope: ProviderPromptTurnScope,
    admissionTask: () => Promise<TPrepared>,
    promptTurnTask: (prepared: TPrepared) => Promise<TResult>,
  ): Promise<TResult> {
    const prepared = await runPromptAdmission(scope, admissionTask);
    return runPromptTurn(scope, () => promptTurnTask(prepared));
  }

  async function drain() {
    await Promise.allSettled([admissionQueue.drain(), promptTurnQueue.drain()]);
  }

  return {
    runAdmission,
    runPromptAdmission,
    runControl,
    runLocal,
    runInteractiveCallback,
    runPromptTurn,
    runPromptTurnAfterAdmission,
    drain,
  };
}
