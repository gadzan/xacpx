export interface AvatarClockEnvironment {
  requestFrame(callback: (time: number) => void): number;
  cancelFrame(id: number): void;
  hidden(): boolean;
  onVisibility(callback: () => void): () => void;
}
export function createAvatarClock(environment: AvatarClockEnvironment) {
  const subscribers = new Set<(elapsed: number) => void>();
  let frame: number | undefined;
  let previous: number | undefined;
  let releaseVisibility: (() => void) | undefined;
  function stop() {
    if (frame !== undefined) environment.cancelFrame(frame);
    frame = undefined;
    previous = undefined;
  }
  function schedule() {
    if (frame === undefined && subscribers.size && !environment.hidden()) frame = environment.requestFrame(tick);
  }
  function tick(time: number) {
    frame = undefined;
    if (environment.hidden() || !subscribers.size) { stop(); return; }
    const elapsed = previous === undefined ? 0 : Math.min(0.05, Math.max(0, (time - previous) / 1000));
    previous = time;
    subscribers.forEach((subscriber) => subscriber(elapsed));
    schedule();
  }
  function visibility() {
    if (environment.hidden()) stop();
    else schedule();
  }
  return {
    subscribe(callback: (elapsed: number) => void): () => void {
      subscribers.add(callback);
      if (!releaseVisibility) releaseVisibility = environment.onVisibility(visibility);
      schedule();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        subscribers.delete(callback);
        if (!subscribers.size) {
          stop();
          releaseVisibility?.();
          releaseVisibility = undefined;
        }
      };
    },
  };
}

export const avatarClock = createAvatarClock({
  requestFrame: (callback) => window.requestAnimationFrame(callback),
  cancelFrame: (id) => window.cancelAnimationFrame(id),
  hidden: () => document.visibilityState === "hidden",
  onVisibility: (callback) => {
    document.addEventListener("visibilitychange", callback);
    return () => document.removeEventListener("visibilitychange", callback);
  },
});
