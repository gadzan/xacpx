export interface SerializedCallbackQueue {
  enqueue(callback: () => void | Promise<void>): void;
  drain(): Promise<void>;
  getError(): unknown;
}

export function createSerializedCallbackQueue(): SerializedCallbackQueue {
  let chain = Promise.resolve();
  let firstError: unknown;

  return {
    enqueue(callback) {
      chain = chain
        .then(callback)
        .catch((error) => {
          firstError ??= error;
        });
    },
    async drain() {
      await chain;
    },
    getError() {
      return firstError;
    },
  };
}
