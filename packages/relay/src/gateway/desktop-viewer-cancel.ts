/**
 * Desktop stream ownership: which authenticated browser viewer owns which
 * in-flight or paired desktop stream.
 *
 * Lives here (rather than inline in the relay server's WebGateway callback) so
 * the server wiring and its regression test share ONE implementation. A copy in
 * either place lets the other drift: reverting `server.ts` to a version that
 * only tears down locally would still leave a test that instantiates its own
 * copy green, which is exactly how the missing connector cancel survived the
 * first round of tests.
 */

import { MSG } from "@ganglion/xacpx-relay-protocol";

import type { InstanceGateway } from "./instance-gateway.js";
import type { DesktopStreamGateway } from "./desktop-stream-gateway.js";

export interface DesktopStreamOwner {
  viewerId: string;
  accountId: string;
  instanceId: string;
  /**
   * The browser's `desktop-open` requestId, carried so a later
   * `desktop-close` that knows only the requestId (the prepare had not
   * reported back yet) can still find and release this reservation.
   *
   * It survives until the browser binary side attaches: `reportConnectorReady`
   * usually only reaches `waiting-browser`, and the frames that decide the race
   * (close-by-requestId + reopen) are still in flight across sockets at that
   * point. Clear it at the browser attach, not at the connector's readiness
   * report, or that reopen fails `desktop-busy` against a stream the viewer is
   * walking away from.
   */
  requestId?: string;
}

/**
 * Best-effort notification that all later failure paths depend on: the
 * connector starts dialing the moment it receives `desktopPrepare`, so every
 * post-reserve exit has to tell it to stop, not just clear hub-side state.
 *
 * Never throws and never blocks the caller's cleanup — `sendEvent` failing
 * (instance already offline, socket mid-close) must still leave the local
 * cancellation done. The connector's own ticket check is the backstop for a
 * cancel it never received.
 */
export function sendDesktopCancel(
  gateway: InstanceGateway | null,
  instanceId: string,
  streamId: string,
): void {
  try {
    gateway?.sendEvent(instanceId, MSG.desktopCancel, { streamId });
  } catch {
    // Deliberately swallowed: see the doc comment.
  }
}

/**
 * Release a desktop reservation the viewer can only name by requestId — an open
 * whose `desktop-opened` has not reached the browser yet, so there is no
 * streamId to name. Viewer-scoped: only a stream this viewer owns and has not
 * paired is matchable.
 *
 * "Not paired" is deliberately wider than "not preparing". `reportConnectorReady`
 * usually only reaches `waiting-browser` (connector attached, browser not), and
 * the frames that settle the race — the close by requestId and the reopen after
 * it — are still in flight across sockets at that point. Narrowing this to
 * `preparing` is what let a close-then-reopen fail `desktop-busy` against a
 * stream the viewer was walking away from.
 *
 * Returns true when a reservation was actually released.
 */
export function cancelViewerDesktopStreamByRequest(
  gateway: InstanceGateway | null,
  desktop: DesktopStreamGateway,
  owners: Map<string, DesktopStreamOwner>,
  requestId: string,
  viewerId: string,
  reason = "viewer-disconnected",
): boolean {
  for (const [streamId, owner] of [...owners]) {
    if (owner.requestId !== requestId || owner.viewerId !== viewerId) continue;
    const state = desktop.streamState(streamId);
    if (state !== "preparing" && state !== "waiting-browser") continue;
    sendDesktopCancel(gateway, owner.instanceId, streamId);
    owners.delete(streamId);
    desktop.closeStream(streamId, reason);
    return true;
  }
  return false;
}

/**
 * Cancel every desktop stream owned by a viewer that just went away, telling
 * the connector first so its in-flight probe / TCP dial / hub upgrade aborts
 * instead of running until its own stage timeouts.
 *
 * `owners` is mutated in place (the server keeps a long-lived map keyed by
 * streamId), and `gateway` may be null before the server has built the
 * instance gateway — which only means the connector is not reachable yet, so
 * there is nothing to notify.
 */
export function cancelViewerDesktopStreams(
  gateway: InstanceGateway | null,
  desktop: DesktopStreamGateway,
  owners: Map<string, DesktopStreamOwner>,
  viewerId: string,
): void {
  // Snapshot before mutating: the loop deletes from `owners` as it goes.
  for (const [streamId, owner] of [...owners]) {
    if (owner.viewerId !== viewerId) continue;
    // Notify BEFORE the local teardown, mirroring web-inbound's desktop-close.
    sendDesktopCancel(gateway, owner.instanceId, streamId);
    owners.delete(streamId);
    desktop.closeStream(streamId, "viewer-disconnected");
  }
}
