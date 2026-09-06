import { expect, test } from "bun:test";

import { processBridgeInput, resolveBridgeSharedConfig } from "../../../src/bridge/bridge-main";

test("resolveBridgeSharedConfig carries queueOwnerTtlSeconds through, including explicit 0", () => {
  const zero = resolveBridgeSharedConfig((name) =>
    name === "BRIDGE_QUEUE_OWNER_TTL_SECONDS" ? "0" : undefined,
  );
  expect(zero.queueOwnerTtlSeconds).toBe(0);
  const unset = resolveBridgeSharedConfig(() => undefined);
  expect(unset.queueOwnerTtlSeconds).toBeUndefined();
  const configured = resolveBridgeSharedConfig((name) =>
    name === "BRIDGE_QUEUE_OWNER_TTL_SECONDS" ? "1800" : undefined,
  );
  expect(configured.queueOwnerTtlSeconds).toBe(1800);
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, timeoutMs = 200): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start >= timeoutMs) {
      throw new Error("timed out waiting for predicate");
    }
    await Bun.sleep(1);
  }
}

function makeInput(lines: string[]) {
  let closed = false;

  return {
    closed: () => closed,
    close() {
      closed = true;
    },
    async *[Symbol.asyncIterator]() {
      for (const line of lines) {
        if (closed) {
          break;
        }
        yield line;
      }
    },
  };
}

test("processBridgeInput begins later stdin line processing before earlier request finishes and forwards streamed and final stdout lines", async () => {
  const started: string[] = [];
  const writes: string[] = [];
  const firstResponse = deferred<string>();
  const secondResponse = deferred<string>();

  const firstLine = '{"id":"1","method":"prompt","params":{"agent":"codex","cwd":"/repo","name":"demo","text":"first"}}';
  const secondLine = '{"id":"2","method":"cancel","params":{"agent":"codex","cwd":"/repo","name":"demo"}}';
  const firstChunk = '{"id":"1","event":"prompt.segment","text":"partial"}\n';
  const firstResult = '{"id":"1","ok":true,"result":{}}\n';
  const secondResult = '{"id":"2","ok":true,"result":{}}\n';

  const input = makeInput([firstLine, secondLine]);
  const runPromise = processBridgeInput({
    input,
    server: {
      async handleLine(line: string, writeLine?: (line: string) => void): Promise<string> {
        started.push(line);
        if (line === firstLine) {
          writeLine?.(firstChunk);
          return await firstResponse.promise;
        }
        if (line === secondLine) {
          return await secondResponse.promise;
        }
        throw new Error(`unexpected line: ${line}`);
      },
    },
    write: (chunk) => {
      writes.push(chunk);
      return true;
    },
  });

  await waitFor(() => started.length === 2 && writes.includes(firstChunk));

  expect(started).toEqual([firstLine, secondLine]);
  expect(writes).toEqual([firstChunk]);

  firstResponse.resolve(firstResult);
  secondResponse.resolve(secondResult);

  await runPromise;

  expect(writes[0]).toBe(firstChunk);
  expect(writes.slice(1).sort()).toEqual([firstResult, secondResult].sort());
});

test("processBridgeInput rethrows a request or write failure after in-flight work settles", async () => {
  const writes: string[] = [];
  const line = '{"id":"1","method":"prompt","params":{"agent":"codex","cwd":"/repo","name":"demo","text":"first"}}';
  const failure = new Error("boom");
  const input = makeInput([line]);

  await expect(
    processBridgeInput({
      input,
      server: {
        async handleLine(): Promise<string> {
          throw failure;
        },
      },
      write: (chunk) => {
        writes.push(chunk);
        return true;
      },
    }),
  ).rejects.toThrow("boom");

  expect(writes).toEqual([]);
  expect(input.closed()).toBe(true);
});
