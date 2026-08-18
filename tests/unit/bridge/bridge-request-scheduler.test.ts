import { expect, test } from "bun:test";

import { BridgeRequestScheduler } from "../../../src/bridge/bridge-request-scheduler";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("normal requests for the same session run serially", async () => {
  const scheduler = new BridgeRequestScheduler();
  const firstStarted = deferred<void>();
  const firstRelease = deferred<void>();
  const secondStarted = deferred<void>();
  let secondHasStarted = false;
  secondStarted.promise.then(() => {
    secondHasStarted = true;
  });

  const first = scheduler.run("session-a", "normal", async () => {
    firstStarted.resolve();
    await firstRelease.promise;
    return "first";
  });

  const second = scheduler.run("session-a", "normal", async () => {
    secondStarted.resolve();
    return "second";
  });

  await firstStarted.promise;
  expect(secondHasStarted).toBe(false);

  firstRelease.resolve();

  await expect(first).resolves.toBe("first");
  await expect(secondStarted.promise).resolves.toBeUndefined();
  await expect(second).resolves.toBe("second");
});

test("control requests for the same session can run while a normal request is still pending", async () => {
  const scheduler = new BridgeRequestScheduler();
  const normalStarted = deferred<void>();
  const normalRelease = deferred<void>();
  const controlStarted = deferred<void>();
  let normalCompleted = false;

  const normal = scheduler.run("session-a", "normal", async () => {
    normalStarted.resolve();
    await normalRelease.promise;
    normalCompleted = true;
  });

  await normalStarted.promise;

  const control = scheduler.run("session-a", "control", async () => {
    controlStarted.resolve();
    return "control";
  });

  await controlStarted.promise;
  expect(normalCompleted).toBe(false);
  await expect(control).resolves.toBe("control");

  normalRelease.resolve();
  await expect(normal).resolves.toBeUndefined();
  expect(normalCompleted).toBe(true);
});

test("message requests run while a normal request is pending and stay FIFO with each other", async () => {
  const scheduler = new BridgeRequestScheduler();
  const normalStarted = deferred<void>();
  const normalRelease = deferred<void>();
  const firstMessageStarted = deferred<void>();
  const firstMessageRelease = deferred<void>();
  const secondMessageStarted = deferred<void>();
  let normalCompleted = false;
  let secondMessageHasStarted = false;
  void secondMessageStarted.promise.then(() => {
    secondMessageHasStarted = true;
  });

  const normal = scheduler.run("session-a", "normal", async () => {
    normalStarted.resolve();
    await normalRelease.promise;
    normalCompleted = true;
  });
  await normalStarted.promise;

  const firstMessage = scheduler.run("session-a", "message", async () => {
    firstMessageStarted.resolve();
    await firstMessageRelease.promise;
    return "first";
  });
  const secondMessage = scheduler.run("session-a", "message", async () => {
    secondMessageStarted.resolve();
    return "second";
  });

  await firstMessageStarted.promise;
  expect(normalCompleted).toBe(false);
  expect(secondMessageHasStarted).toBe(false);

  firstMessageRelease.resolve();
  await expect(firstMessage).resolves.toBe("first");
  await expect(secondMessageStarted.promise).resolves.toBeUndefined();
  await expect(secondMessage).resolves.toBe("second");

  normalRelease.resolve();
  await expect(normal).resolves.toBeUndefined();
});

test("different sessions can progress independently", async () => {
  const scheduler = new BridgeRequestScheduler();
  const aStarted = deferred<void>();
  const aRelease = deferred<void>();
  const bStarted = deferred<void>();
  let aCompleted = false;

  const blocked = scheduler.run("session-a", "normal", async () => {
    aStarted.resolve();
    await aRelease.promise;
    aCompleted = true;
    return "a";
  });

  await aStarted.promise;

  const independent = scheduler.run("session-b", "normal", async () => {
    bStarted.resolve();
    return "b";
  });

  await bStarted.promise;
  expect(aCompleted).toBe(false);
  await expect(independent).resolves.toBe("b");

  aRelease.resolve();
  await expect(blocked).resolves.toBe("a");
});

test("scheduler cleans up idle session state after completion", async () => {
  const scheduler = new BridgeRequestScheduler();

  await expect(
    scheduler.run("session-a", "normal", async () => "done"),
  ).resolves.toBe("done");

  const { sessions } = scheduler as unknown as { sessions: Map<string, unknown> };
  expect(sessions.size).toBe(0);

  await expect(
    scheduler.run("session-a", "normal", async () => "done-again"),
  ).resolves.toBe("done-again");
  expect(sessions.size).toBe(0);
});

test("a rejected normal request does not poison later normal work for the same session", async () => {
  const scheduler = new BridgeRequestScheduler();
  const firstStarted = deferred<void>();
  const firstFailed = deferred<void>();
  const secondStarted = deferred<void>();

  const first = scheduler.run("session-a", "normal", async () => {
    firstStarted.resolve();
    await firstFailed.promise;
    return "first";
  });

  await firstStarted.promise;

  const second = scheduler.run("session-a", "normal", async () => {
    secondStarted.resolve();
    return "second";
  });

  firstFailed.reject(new Error("boom"));

  await expect(first).rejects.toThrow("boom");
  await expect(secondStarted.promise).resolves.toBeUndefined();
  await expect(second).resolves.toBe("second");
});
