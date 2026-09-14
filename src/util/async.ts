export function settleWithinTimeout(work: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    if (typeof (timer as NodeJS.Timeout).unref === "function") {
      (timer as NodeJS.Timeout).unref();
    }
    void work.then(
      () => { clearTimeout(timer); finish(); },
      () => { clearTimeout(timer); finish(); },
    );
  });
}
/**
 * Race work against a watchdog timer, clearing the timer as soon as either
 * side settles. Unlike a bare `Promise.race` with `setTimeout`, a fast
 * success does not leave a dangling timer/closure alive until the deadline.
 */
export function raceWithTimeout<T>(work: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), timeoutMs);
    if (typeof (timer as NodeJS.Timeout).unref === "function") {
      (timer as NodeJS.Timeout).unref();
    }
    void work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
