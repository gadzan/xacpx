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

  /**
   * Run one section while holding every listed Bot gate simultaneously.
   * Gates nest innermost-last in sorted order (deduped): distinct per-Bot
   * mutexes, so nesting is deadlock-free; the same Bot never re-enters its
   * own gate here because materialization never calls back into this. Lets
   * teardown linearize its barrier against in-flight materialization — the
   * section performs the barrier synchronously under the gates without
   * session work, so no deadlock.
   */
  async runAll<T>(botIds: readonly string[], critical: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(botIds)].sort();
    const [head, ...tail] = ordered;
    if (!head) {
      return await critical();
    }
    let mutex = this.locks.get(head);
    if (!mutex) {
      mutex = new AsyncMutex();
      this.locks.set(head, mutex);
    }
    return await mutex.run(() => this.runAll(tail, critical));
  }
}
