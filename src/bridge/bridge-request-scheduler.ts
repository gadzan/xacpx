export type BridgeRequestLane = "normal" | "message" | "control";

type Task<T> = () => T | Promise<T>;

interface SessionState {
  pendingNormals: number;
  pendingMessages: number;
  normalTail: Promise<void>;
  messageTail: Promise<void>;
}

export class BridgeRequestScheduler {
  private readonly sessions = new Map<string, SessionState>();

  run<T>(sessionName: string, lane: BridgeRequestLane, task: Task<T>): Promise<T> {
    if (lane === "control") {
      return Promise.resolve().then(task);
    }

    const state = this.sessions.get(sessionName) ?? this.createSessionState(sessionName);
    const tailName = lane === "message" ? "messageTail" : "normalTail";
    const pendingName = lane === "message" ? "pendingMessages" : "pendingNormals";
    state[pendingName] += 1;

    const result = state[tailName].then(() => task());
    state[tailName] = result.then(
      () => undefined,
      () => undefined,
    );

    return result.finally(() => {
      state[pendingName] -= 1;
      if (state.pendingNormals === 0 && state.pendingMessages === 0 && this.sessions.get(sessionName) === state) {
        this.sessions.delete(sessionName);
      }
    });
  }

  private createSessionState(sessionName: string): SessionState {
    const state: SessionState = {
      pendingNormals: 0,
      pendingMessages: 0,
      normalTail: Promise.resolve(),
      messageTail: Promise.resolve(),
    };
    this.sessions.set(sessionName, state);
    return state;
  }
}
