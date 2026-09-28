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
