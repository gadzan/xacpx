export interface MessageDedupOptions {
  ttlMs?: number;
  maxEntries?: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10000;

export function isMessageExpired(createTimestamp: number | undefined, expiryMs = 5 * 60 * 1000): boolean {
  if (!createTimestamp) return false;
  return Date.now() - createTimestamp > expiryMs;
}

export class MessageDedup {
  private readonly store = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: MessageDedupOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  tryRecord(id: string, scope?: string): boolean {
    const key = scope ? `${scope}:${id}` : id;
    const now = Date.now();
    const existing = this.store.get(key);
    if (existing !== undefined && now - existing < this.ttlMs) {
      return false;
    }
    if (existing !== undefined) {
      this.store.delete(key);
    }
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, now);
    return true;
  }

  dispose(): void {
    this.store.clear();
  }
}
