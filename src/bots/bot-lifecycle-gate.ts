import { AsyncMutex } from "../orchestration/async-mutex";

/**
 * Per-Bot exclusive gate for direct runtime materialization, execution-identity
 * mutation, and deletion. Independent from the daemon `stateMutex` so callers
 * can await `SessionService` without a non-reentrant deadlock.
 */
export class BotLifecycleGate {
  private readonly locks = new Map<string, AsyncMutex>();

  async run<T>(botId: string, critical: () => Promise<T>): Promise<T> {
    let mutex = this.locks.get(botId);
    if (!mutex) {
      mutex = new AsyncMutex();
      this.locks.set(botId, mutex);
    }
    return await mutex.run(critical);
  }
}
