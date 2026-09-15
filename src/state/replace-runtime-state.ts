import type { AppState } from "./types";

/** Publish a fully persisted snapshot without changing the live state identity. */
export function replaceRuntimeState(target: AppState, source: AppState): void {
  Object.assign(target, source);
}
