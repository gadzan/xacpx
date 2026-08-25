import {
  MSG,
  RELAY_PROTOCOL_VERSION,
  TERMINAL_HUB_REQUEST_TIMEOUT_MS,
  decodeEnvelope,
  encodeEnvelope,
  errorPayload,
  normalizeCapabilities,
  type AgentMessageCompletionPayload,
  type AgentMessageDeliverPayload,
  type AgentMessageRoutePayload,
  type InstanceAgentEndpointsSyncPayload,
  type InstanceAuthPayload,
  type InstanceRegisterPayload,
  type PublishedAgentEndpointDto,
  type RelayEnvelope,
  type WebAgentDirectoryEndpointDto,
} from "@ganglion/xacpx-relay-protocol";
import type { AccountStore } from "../stores/accounts.js";
import type { InstanceStore } from "../stores/instances.js";
import type { PendingCompletionRouteRow } from "../stores/pending-completion-routes.js";
import { createNoopRelayLogger, type RelayLogger } from "../logging.js";
import { startHeartbeat } from "./heartbeat.js";

/** Single authoritative default for the gateway RPC timeout, shared by the server layer. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
export const REQUEST_RESPONSE_RESERVE_MS = 15_000;
/** Default timeout for recoverable terminal open/take-control/resync/terminate.
 *  Must exceed REQUEST_RESPONSE_RESERVE_MS so requestBudgetMs stays large enough
 *  for RMUX create (~15s) without Hub timing out first and creating ghost terminals. */
export const TERMINAL_REQUEST_TIMEOUT_MS = TERMINAL_HUB_REQUEST_TIMEOUT_MS;

export interface GatewaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Optional (real `ws` sockets have them): enables the keepalive heartbeat. */
  ping?(): void;
  terminate?(): void;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "pong", listener: () => void): unknown;
}

export interface InstanceGatewayDeps {
  instances: Pick<
    InstanceStore,
    | "redeemPairingToken"
    | "registerInstanceForAccount"
    | "verifyCredential"
    | "touch"
  >;
  accounts: Pick<AccountStore, "resolveLoginToken">;
  requestTimeoutMs?: number;
  /** Keepalive ping cadence; overridable for tests. Defaults to HEARTBEAT_INTERVAL_MS. */
  heartbeatIntervalMs?: number;
  onEvent?: (
    instanceId: string,
    accountId: string,
    envelope: RelayEnvelope,
  ) => void;
  onStatusChange?: (
    instanceId: string,
    accountId: string,
    online: boolean,
  ) => void;
  /** Durable backing store for private completion ROUTE grants (v0.3). */
  pendingCompletionRoutes?: {
    load(): PendingCompletionRouteRow[];
    insert(grant: PendingCompletionRouteRow): void;
    markDelivered(requestMessageId: string): void;
    delete(requestMessageId: string): void;
    /** Durable TTL cleanup — must reach SQLite, not only RAM. */
    sweepExpired(now: number): number;
  };
  /**
   * Test seam: called when an authenticated instance delivers an RPC response
   * that matched its pending request. Returning true simulates an ACK loss —
   * the response is swallowed and the pending request fails as an ambiguous
   * transport error ("timeout") without waiting out the request timeout, which
   * exercises the source-side retry + destination dedupe path end to end while
   * keeping tests free of wall-clock timeouts.
   */
  dropRequestResponse?: (
    instanceId: string,
    type: string,
    payload: unknown,
  ) => boolean;
  onDirectoryChange?: (
    accountId: string,
    endpoints: WebAgentDirectoryEndpointDto[],
  ) => void;
  logger?: RelayLogger;
}

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  instanceId: string;
  /** The socket the request was sent over — a response must come from THAT socket,
   *  not a different (even legitimately-authed) instance socket. */
  socket: GatewaySocket;
  /** The RPC type — the response envelope must echo it. */
  type: string;
}

export class InstanceGateway {
  private readonly connections = new Map<
    string,
    { socket: GatewaySocket; accountId: string }
  >();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly logger: RelayLogger;
  private readonly endpointsByInstance = new Map<
    string,
    PublishedAgentEndpointDto[]
  >();
  private seq = 0;
  /**
   * v0.3 private completion ROUTE grants. Recorded when an agentMessageRoute
   * with completion != none is ACCEPTED by the target; subsequent completions
   * authenticate against this grant and route to the ORIGINAL source instance
   * — fully decoupled from the live public Agent Directory so post-request
   * archive/sleep on either side cannot revoke (or forge) the established
   * contract. TTL + size bounded.
   */
  private readonly pendingCompletionRoutes = new Map<
    string,
    PendingCompletionRouteRow
  >();
  private static readonly PENDING_COMPLETION_TTL_MS = 24 * 60 * 60_000;
  private static readonly PENDING_COMPLETION_MAX_ENTRIES = 5_000;
  /** Application rejections that PROVE the target never admitted the request
   *  (error payloads carrying these codes compensate a provisional grant).
   *  Timeout/race codes and unknown payloads stay ambiguous → grant retained. */
  private static readonly DEFINITE_ROUTE_REJECTION_CODES: ReadonlySet<string> =
    new Set([
      "TARGET_UNAVAILABLE",
      "TARGET_NOT_FOUND",
      "TARGET_NODE_OFFLINE",
      "MESSAGE_QUEUE_FULL",
      "DELIVERY_DENIED",
      "COMPLETION_NOT_SUPPORTED",
      "CONVERSATION_LIMIT_REACHED",
      "DUPLICATE_MESSAGE",
      "MESSAGE_RATE_LIMITED",
      // v0.4: the destination's capability revalidation fires BEFORE any
      // cancellation — a stale source directory (interrupt=true) routed to a
      // target that currently resolves interrupt=false is a definite
      // not-sent: zero target admission, zero cancel, so BOTH the source's
      // completion grant and the Hub's provisional route grant must
      // compensate immediately instead of lingering to TTL.
      "TARGET_NOT_INTERRUPTIBLE",
    ]);


  constructor(private readonly deps: InstanceGatewayDeps) {
    this.logger = deps.logger ?? createNoopRelayLogger();
    // Hydrate durable route grants. Expired rows are pruned; survivors keep
    // already-accepted completion contracts enforceable across Hub restarts.
    const now = Date.now();
    try {
      for (const grant of this.deps.pendingCompletionRoutes?.load() ?? []) {
        if (grant.expiresAt <= now) continue;
        this.pendingCompletionRoutes.set(grant.requestMessageId, grant);
      }
    } catch {
      // Fail-closed: an unloadable store starts empty (completions for
      // pre-restart requests will be denied rather than mis-routed).
    }
  }

  /**
   * Durable-reserve a completion ROUTE grant. The SQLite row is written FIRST
   * (row-level atomic); only then does the in-memory map update. A storage
   * failure propagates so callers fail closed BEFORE forwarding the request —
   * a grant that is not durable must never back an outward "will complete"
   * contract.
   *
   * Backpressure, not eviction: expired grants are pruned first; if the store
   * is STILL at capacity, the NEW request is refused rather than silently
   * revoking an older contract that may still be executing.
   */
  private recordPendingCompletionRoute(
    requestMessageId: string,
    grant: PendingCompletionRouteRow,
  ): { created: boolean } {
    // Expired rows are pruned durably (SQLite delete), not just from RAM.
    this.sweepExpiredCompletionRoutes();

    // Same-message retry support (source ACK-loss / ambiguous outcome): a retry
    // of an ALREADY-RESERVED request must reuse the existing grant, never
    // re-insert. Fingerprints bind account + both instance ids + both
    // endpoints + mode — any difference is a forgery attempt on a live
    // contract and is denied without touching the original row.
    const existing = this.pendingCompletionRoutes.get(requestMessageId);
    if (existing) {
      const sameFingerprint =
        existing.accountId === grant.accountId &&
        existing.sourceInstanceId === grant.sourceInstanceId &&
        existing.source.nodeId === grant.source.nodeId &&
        existing.source.endpointId === grant.source.endpointId &&
        existing.targetInstanceId === grant.targetInstanceId &&
        existing.target.nodeId === grant.target.nodeId &&
        existing.target.endpointId === grant.target.endpointId &&
        existing.mode === grant.mode;
      if (!sameFingerprint) {
        throw new Error(
          `DELIVERY_DENIED: Request ${requestMessageId} already has a completion route with a different fingerprint`,
        );
      }
      // Idempotent reuse — no second INSERT. The caller must NOT treat this
      // attempt's failure as grounds to compensation-delete the standing
      // contract (an earlier delivery may already be executing).
      return { created: false };
    }

    let pendingCount = 0;
    for (const [, g] of [...this.pendingCompletionRoutes]) {
      if (g.state === "pending") pendingCount += 1;
    }
    if (
      pendingCount >= InstanceGateway.PENDING_COMPLETION_MAX_ENTRIES
    ) {
      throw new Error("PENDING_COMPLETION_ROUTE_CAPACITY");
    }
    this.deps.pendingCompletionRoutes?.insert(grant);
    this.pendingCompletionRoutes.set(requestMessageId, grant);
    return { created: true };
  }

  /**
   * Retire a route grant. The SQLite delete runs FIRST; only after it succeeds
   * is the in-memory entry removed, so RAM and store can never disagree about
   * whether an authorization exists. Storage failure → grant stays live in
   * both places and the caller surfaces the error (retry later).
   */
  private deletePendingCompletionRoute(requestMessageId: string): void {
    this.deps.pendingCompletionRoutes?.delete(requestMessageId);
    this.pendingCompletionRoutes.delete(requestMessageId);
  }

  /**
   * Durably remove every expired route row (pending or delivered tombstone).
   * Called from the reservation path and safe to call periodically — TTL
   * cleanup must reach SQLite, not only the RAM map, or a long-running Hub
   * accumulates rows forever.
   */
  sweepExpiredCompletionRoutes(): void {
    const now = Date.now();
    if (this.deps.pendingCompletionRoutes) {
      this.deps.pendingCompletionRoutes.sweepExpired(now);
      for (const [id, g] of [...this.pendingCompletionRoutes]) {
        if (g.expiresAt <= now) this.pendingCompletionRoutes.delete(id);
      }
      return;
    }
    for (const [id, g] of [...this.pendingCompletionRoutes]) {
      if (g.expiresAt <= now) this.pendingCompletionRoutes.delete(id);
    }
  }


  isOnline(instanceId: string): boolean {
    return this.connections.has(instanceId);
  }

  handleConnection(socket: GatewaySocket): void {
    let authed: { instanceId: string; accountId: string } | null = null;
    startHeartbeat(
      socket,
      this.deps.heartbeatIntervalMs,
      undefined,
      this.logger,
    );

    socket.on("message", (data) => {
      try {
        this.handleMessage(socket, data, authed, (identity) => {
          authed = identity;
        });
      } catch (err) {
        this.logger.error(
          "relay.instance.message_failed",
          "message handling failed",
          { error: String(err) },
        );
      }
    });

    socket.on("close", () => {
      if (!authed) return;
      // Only the socket that currently owns the map entry may take the instance
      // offline. A superseded socket's late close (see handleMessage) would
      // otherwise evict the NEW connection and reject its in-flight requests; a
      // REVOKED socket (disconnect() already dropped the entry) likewise no-ops.
      const current = this.connections.get(authed.instanceId);
      if (current?.socket !== socket) return;
      this.dropConnection(authed.instanceId, authed.accountId);
      this.logger.info("relay.instance.offline", "instance disconnected", {
        instanceId: authed.instanceId,
        accountId: authed.accountId,
      });
    });
  }

  /** Remove the instance's connection entry, reject its in-flight requests, and
   *  notify the offline transition. Shared by the close handler and disconnect(). */
  private dropConnection(instanceId: string, accountId: string): void {
    this.endpointsByInstance.delete(instanceId);
    this.connections.delete(instanceId);
    for (const [id, p] of this.pending) {
      if (p.instanceId === instanceId) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new Error("instance-offline"));
      }
    }
    this.deps.onStatusChange?.(instanceId, accountId, false);
    // The directory shrank with this instance's endpoints: push the new snapshot
    // to every remaining same-account instance immediately so peers stop
    // advertising a dead node (agent_list auto-updates without waiting for the
    // next sync). No-op when nobody is left in the account.
    this.broadcastDirectorySnapshot(accountId);
  }

  private handleMessage(
    socket: GatewaySocket,
    data: unknown,
    authed: { instanceId: string; accountId: string } | null,
    setAuthed: (identity: { instanceId: string; accountId: string }) => void,
  ): void {
    const decoded = decodeEnvelope(String(data));
    if (!decoded.ok) {
      socket.send(
        encodeEnvelope({
          protocolVersion: RELAY_PROTOCOL_VERSION,
          kind: "event",
          type: "relay.protocol-error",
          payload: errorPayload(
            decoded.error,
            decoded.detail ?? "invalid envelope",
          ),
        }),
      );
      if (!authed) socket.close(4400, decoded.error);
      return;
    }
    const envelope = decoded.envelope;

    if (!authed) {
      const identity = this.handleHandshake(socket, envelope);
      if (identity) {
        setAuthed(identity);
        // A reconnect can race the old (often half-open) socket: replace the map
        // entry FIRST, then close the old socket, whose close handler no-ops
        // because the entry no longer points at it.
        const existing = this.connections.get(identity.instanceId);
        this.connections.set(identity.instanceId, {
          socket,
          accountId: identity.accountId,
        });
        if (existing && existing.socket !== socket) {
          this.logger.info(
            "relay.instance.superseded",
            "reconnect superseded old socket",
            { instanceId: identity.instanceId },
          );
          // The old socket's pending RPCs can never be answered (their responses are
          // fenced out) — reject them NOW instead of letting the HTTP call wait out
          // the full request timeout. No offline transition: the new socket owns the
          // instance.
          this.rejectPendingForSocket(existing.socket, "instance-reconnected");
          try {
            existing.socket.close(4409, "superseded");
          } catch (err) {
            this.logger.error(
              "relay.instance.superseded_close_failed",
              "closing superseded instance socket failed",
              { error: String(err) },
            );
          }
        }
        this.deps.onStatusChange?.(
          identity.instanceId,
          identity.accountId,
          true,
        );
        this.logger.info("relay.instance.online", "instance connected", {
          instanceId: identity.instanceId,
          accountId: identity.accountId,
        });
        this.sendEvent(identity.instanceId, MSG.agentDirectorySnapshot, {
          endpoints: this.getPublishedEndpoints(identity.accountId),
        });
      }
      return;
    }

    // Socket ownership fencing: only the socket that CURRENTLY owns the instance's
    // map entry may deliver messages. A revoked socket (disconnect() dropped the
    // entry) or a superseded one (a reconnect replaced it) must not keep feeding
    // events/state-syncs into onEvent — a late `turn-finished` after a persist-failed
    // disconnect would persist + ack, bypassing the reconnect/resync retry, and a
    // late state sync from a superseded socket could clobber the newer connection's
    // recovered state.
    const current = this.connections.get(authed.instanceId);
    if (current?.socket !== socket) {
      this.logger.debug(
        "relay.instance.stale_socket",
        "dropped message from a revoked/superseded socket",
        { instanceId: authed.instanceId },
      );
      return;
    }

    if (envelope.kind === "res" && envelope.id) {
      const waiting = this.pending.get(envelope.id);
      // Response ownership: the id alone is not enough — request ids are sequential
      // and guessable, so a DIFFERENT (even legitimately-authed) instance socket
      // could spoof another instance's pending RPC and make the hub trust a forged
      // result (markQueued, history deletion, output rows...). The response must come
      // from the SAME instance + SAME socket the request went out on, and echo the
      // request type.
      if (
        !waiting ||
        waiting.instanceId !== authed.instanceId ||
        waiting.socket !== socket ||
        waiting.type !== envelope.type
      ) {
        this.logger.warn(
          "relay.instance.response_mismatch",
          "dropped RPC response that does not match its pending request",
          {
            instanceId: authed.instanceId,
            envelopeType: envelope.type,
          },
        );
        return;
      }
      if (
        this.deps.dropRequestResponse?.(
          authed.instanceId,
          envelope.type,
          envelope.payload,
        )
      ) {
        this.logger.info(
          "relay.instance.response_dropped",
          "dropped authenticated RPC response (test seam: simulated ACK loss)",
          { instanceId: authed.instanceId, envelopeType: envelope.type },
        );
        // The response is lost from the caller's perspective: fail the pending
        // request as an ambiguous transport error immediately (a real lost ACK
        // would surface as a timeout). The target MAY already have accepted the
        // message — the source retries with the same messageId and the
        // destination deduplicates.
        clearTimeout(waiting.timer);
        this.pending.delete(envelope.id);
        waiting.reject(new Error("timeout"));
        return;
      }
      clearTimeout(waiting.timer);
      this.pending.delete(envelope.id);
      waiting.resolve(envelope.payload);
      return;
    }
    if (envelope.kind === "event") {
      this.deps.instances.touch(authed.instanceId);
      this.deps.onEvent?.(authed.instanceId, authed.accountId, envelope);
      if (envelope.type === MSG.instanceAgentEndpointsSync) {
        const syncPayload =
          envelope.payload as InstanceAgentEndpointsSyncPayload;
        if (Array.isArray(syncPayload?.endpoints)) {
          if (syncPayload.endpoints.length === 0) {
            this.endpointsByInstance.delete(authed.instanceId);
          } else {
            const claimedNodeIds = new Set(
              syncPayload.endpoints.map((e) => e.nodeId),
            );
            for (const [otherInstId, conn] of this.connections) {
              if (
                otherInstId !== authed.instanceId &&
                conn.accountId === authed.accountId
              ) {
                const otherEndpoints =
                  this.endpointsByInstance.get(otherInstId) ?? [];
                if (otherEndpoints.some((e) => claimedNodeIds.has(e.nodeId))) {
                  this.logger.warn(
                    "relay.instance.node_id_collision",
                    "instance tried to claim nodeId owned by another active instance",
                    { instanceId: authed.instanceId },
                  );
                  return;
                }
              }
            }
            this.endpointsByInstance.set(
              authed.instanceId,
              syncPayload.endpoints,
            );
          }
          this.broadcastDirectorySnapshot(authed.accountId);
        }
      }
      return;
    }
    if (envelope.kind === "req" && envelope.id) {
      const respond = (payload: unknown) => {
        socket.send(
          encodeEnvelope({
            protocolVersion: RELAY_PROTOCOL_VERSION,
            kind: "res",
            id: envelope.id,
            type: envelope.type,
            payload,
          }),
        );
      };

      if (envelope.type === MSG.agentDirectoryQuery) {
        respond({ endpoints: this.getPublishedEndpoints(authed.accountId) });
        return;
      }

      if (envelope.type === MSG.agentMessageRoute) {
        const routePayload = envelope.payload as AgentMessageRoutePayload;
        // Fail-closed source identity: the canonical source node/endpoint must
        // belong to the authenticated instance's CURRENTLY published directory.
        // A caller cannot spoof another node's (or another account's) identity —
        // the Hub stamps the socket-derived instance, and a mismatched claim is
        // denied outright rather than forwarded.
        const sourceEndpoints =
          this.endpointsByInstance.get(authed.instanceId) ?? [];
        const sourceEndpoint = sourceEndpoints.find(
          (e) =>
            e.nodeId === routePayload.sourceNodeId &&
            e.endpointId === routePayload.sourceEndpointId,
        );
        if (!sourceEndpoint) {
          respond(
            errorPayload(
              "DELIVERY_DENIED",
              `Source endpoint ${routePayload.sourceEndpointId} is not published by the authenticated instance ${authed.instanceId}`,
            ),
          );
          return;
        }
        // replyable is derived, never hardcoded: the target may reply only when
        // the source endpoint can receive AND the reverse route holds (the
        // endpoint is published by an online instance — verified above).
        const replyable = sourceEndpoint.capabilities.receive === true;
        let targetInstanceId: string | null = null;
        let targetEndpointFound = false;
        for (const [instId, conn] of this.connections) {
          if (conn.accountId === authed.accountId) {
            const endpoints = this.endpointsByInstance.get(instId) ?? [];
            if (endpoints.some((e) => e.nodeId === routePayload.targetNodeId)) {
              targetInstanceId = instId;
              targetEndpointFound = endpoints.some(
                (e) =>
                  e.nodeId === routePayload.targetNodeId &&
                  e.endpointId === routePayload.targetEndpointId,
              );
              break;
            }
          }
        }
        if (!targetInstanceId) {
          respond(
            errorPayload(
              "TARGET_NODE_OFFLINE",
              `Target node ${routePayload.targetNodeId} is offline`,
            ),
          );
          return;
        }
        if (!targetEndpointFound) {
          respond(
            errorPayload(
              "TARGET_NOT_FOUND",
              `Target endpoint ${routePayload.targetEndpointId} not found on node ${routePayload.targetNodeId}`,
            ),
          );
          return;
        }
        const deliverPayload: AgentMessageDeliverPayload = {
          sourceNodeId: routePayload.sourceNodeId,
          sourceEndpointId: routePayload.sourceEndpointId,
          targetEndpointId: routePayload.targetEndpointId,
          messageId: routePayload.messageId,
          ...(routePayload.conversationId
            ? { conversationId: routePayload.conversationId }
            : {}),
          ...(routePayload.depth !== undefined
            ? { depth: routePayload.depth }
            : {}),
          content: routePayload.content,
          requestedMode: routePayload.requestedMode,
          replyTo: routePayload.replyTo,
          replyable,
          ...(routePayload.completion ? { completion: routePayload.completion } : {}),
        };
        // v0.3 trust boundary: the completion ROUTE grant is durably RESERVED
        // before the request is forwarded. A grant that is not durable must
        // never back an outward "xacpx will complete" contract, so a storage
        // failure fails the request closed (nothing is sent). The grant only
        // becomes final when the target reports exact admission
        // (injected | queued); a definite rejection compensates it away, and
        // an ambiguous transport outcome retains it (the target may have
        // accepted).
        const completionMode = routePayload.completion;
        let provisionalGrant = false;
        let grantCreatedByThisRequest = false;
        if (completionMode === "notify" || completionMode === "result") {
          try {
            const { created } = this.recordPendingCompletionRoute(routePayload.messageId, {
              requestMessageId: routePayload.messageId,
              accountId: authed.accountId,
              sourceInstanceId: authed.instanceId,
              source: {
                nodeId: routePayload.sourceNodeId,
                endpointId: routePayload.sourceEndpointId,
              },
              targetInstanceId,
              target: {
                nodeId: routePayload.targetNodeId,
                endpointId: routePayload.targetEndpointId,
              },
              mode: completionMode,
              expiresAt: Date.now() + InstanceGateway.PENDING_COMPLETION_TTL_MS,
              state: "pending" as const,
            });
            provisionalGrant = true;
            grantCreatedByThisRequest = created;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const isCapacity =
              message === "PENDING_COMPLETION_ROUTE_CAPACITY";
            const isFingerprintConflict = message.startsWith(
              "DELIVERY_DENIED: Request",
            );
            respond(
              errorPayload(
                isCapacity
                  ? "MESSAGE_QUEUE_FULL"
                  : isFingerprintConflict
                    ? "DELIVERY_DENIED"
                    : "DELIVERY_FAILED",
                isCapacity
                  ? "Hub pending completion capacity reached; request not sent"
                  : isFingerprintConflict
                    ? message
                    : `Completion route could not be persisted; request not sent: ${message}`,
              ),
            );
            return;
          }
        }
        this.sendRequest(
          targetInstanceId,
          MSG.agentMessageDeliver,
          deliverPayload,
        )
          .then((res) => {
            if (provisionalGrant) {
              // Classify the target's response:
              //  - exact injected|queued admission → grant stands;
              //  - an APPLICATION error payload (error.code present) with a
              //    known definite pre-admission rejection code → the target
              //    never accepted → compensate the reservation;
              //  - transport ambiguity (timeout/race) or malformed/unknown
              //    payloads → grant RETAINED (the target may have accepted).
              const routeRes = res as {
                status?: string;
                ok?: boolean;
                error?: { code?: string };
              };
              const definiteRejection =
                routeRes.status === "failed" ||
                (routeRes.error?.code !== undefined &&
                  InstanceGateway.DEFINITE_ROUTE_REJECTION_CODES.has(
                    routeRes.error.code,
                  ));
              // Only a grant CREATED by THIS request may be compensated away
              // on definite rejection. A REUSED grant (same-message retry of
              // an already-accepted contract) must survive this attempt's
              // failure — the original delivery may still be in flight.
              if (definiteRejection && grantCreatedByThisRequest) {
                this.deletePendingCompletionRoute(routePayload.messageId);
              }
            }
            respond(res);
          })
          .catch((err) => {
            // Transport-level ambiguity (timeout / lost ACK): the target may
            // have accepted, so the provisional grant is retained.
            void provisionalGrant;
            respond(
              errorPayload(
                (err as Error & { code?: string }).code ?? "DELIVERY_FAILED",
                err instanceof Error ? err.message : String(err),
              ),
            );
          });
        return;
      }

      if (envelope.type === MSG.agentMessageCompletion) {
        const completionPayload =
          envelope.payload as AgentMessageCompletionPayload;
        if (
          !completionPayload ||
          typeof completionPayload !== "object" ||
          !completionPayload.source ||
          !completionPayload.target ||
          !completionPayload.requestMessageId ||
          !completionPayload.status
        ) {
          respond(
            errorPayload(
              "invalid-payload",
              `${MSG.agentMessageCompletion}: malformed payload`,
            ),
          );
          return;
        }

        // v0.3 trust boundary: authorization comes from the PRIVATE route grant
        // recorded when the original agentMessageRoute was accepted — NEVER
        // from the current public Agent Directory. Either side archiving after
        // the request must not revoke (or forge) an established contract.
        const grant = this.pendingCompletionRoutes.get(
          completionPayload.requestMessageId,
        );
        if (!grant || grant.expiresAt <= Date.now()) {
          if (grant) this.deletePendingCompletionRoute(completionPayload.requestMessageId);
          respond(
            errorPayload(
              "DELIVERY_DENIED",
              `No pending completion route exists for request ${completionPayload.requestMessageId}`,
            ),
          );
          return;
        }

        // Terminal tombstone: the completion was already delivered and
        // acknowledged by the source. An at-least-once replay (Hub success ACK
        // lost to the target) is absorbed as deduplicated instead of denying a
        // contract that WAS honored. Fingerprint mismatches stay denied.
        if (grant.state === "delivered") {
          const sameFingerprint =
            authed.instanceId === grant.targetInstanceId &&
            grant.source.nodeId === completionPayload.source.nodeId &&
            grant.source.endpointId === completionPayload.source.endpointId &&
            grant.target.nodeId === completionPayload.target.nodeId &&
            grant.target.endpointId === completionPayload.target.endpointId;
          if (sameFingerprint) {
            respond({ ok: true, deduplicated: true });
          } else {
            respond(
              errorPayload(
                "DELIVERY_DENIED",
                `Completion identities do not match the original route for ${completionPayload.requestMessageId}`,
              ),
            );
          }
          return;
        }

        if (authed.instanceId !== grant.targetInstanceId) {
          respond(
            errorPayload(
              "DELIVERY_DENIED",
              `Completion for ${completionPayload.requestMessageId} must be sent by the instance that accepted the original request`,
            ),
          );
          return;
        }
        if (
          grant.source.nodeId !== completionPayload.source.nodeId ||
          grant.source.endpointId !== completionPayload.source.endpointId ||
          grant.target.nodeId !== completionPayload.target.nodeId ||
          grant.target.endpointId !== completionPayload.target.endpointId
        ) {
          respond(
            errorPayload(
              "DELIVERY_DENIED",
              `Completion identities do not match the original route for ${completionPayload.requestMessageId}`,
            ),
          );
          return;
        }
        if (grant.mode === "notify" && completionPayload.result !== undefined) {
          respond(
            errorPayload(
              "DELIVERY_DENIED",
              "A notify-mode completion must not carry a result body",
            ),
          );
          return;
        }

        // Route to the ORIGINAL source instance — not a re-lookup through the
        // live directory, which would drop completions addressed to endpoints
        // that archived/slept after the request was accepted.
        this.sendRequest(
          grant.sourceInstanceId,
          MSG.agentMessageCompletion,
          completionPayload,
        )
          .then((res) => {
            // Retire the route grant ONLY when the source daemon explicitly
            // accepted ({ ok: true }). Application error payloads resolve as
            // normal responses — treating them as success would sever the
            // contract while the target is still retrying.
            //
            // DB-FIRST durable transition: the SQLite row must read
            // state='delivered' BEFORE the target is told the contract is
            // terminal. A storage failure here keeps RAM + DB pending and
            // responds a RETRYABLE failure — the target's durable outbox
            // retries, the source dedupe absorbs the duplicate, and the
            // durable transition eventually completes.
            if ((res as { ok?: boolean }).ok === true) {
              try {
                this.deps.pendingCompletionRoutes?.markDelivered(
                  completionPayload.requestMessageId,
                );
                grant.state = "delivered";
              } catch (err) {
                respond(
                  errorPayload(
                    "DELIVERY_FAILED",
                    `Completion delivered but terminal state could not be made durable; retry: ${
                      err instanceof Error ? err.message : String(err)
                    }`,
                  ),
                );
                return;
              }
            }
            respond(res);
          })
          .catch((err) =>
            respond(
              errorPayload(
                (err as Error & { code?: string }).code ?? "DELIVERY_FAILED",
                err instanceof Error ? err.message : String(err),
              ),
            ),
          );
        return;
      }
      respond(
        errorPayload(
          "invalid-request",
          `unknown request type: ${envelope.type}`,
        ),
      );
      return;
    }
  }

  /** Returns the authed identity, or null (after replying/closing) when the handshake fails. */
  private handleHandshake(
    socket: GatewaySocket,
    envelope: RelayEnvelope,
  ): { instanceId: string; accountId: string } | null {
    const respond = (payload: unknown) => {
      socket.send(
        encodeEnvelope({
          protocolVersion: RELAY_PROTOCOL_VERSION,
          kind: "res",
          id: envelope.id ?? "handshake",
          type: envelope.type,
          payload,
        }),
      );
    };
    if (envelope.kind !== "req") {
      this.logger.info(
        "relay.instance.handshake_failed",
        "handshake rejected",
        { reason: "not-a-request" },
      );
      socket.close(4401, "unauthenticated");
      return null;
    }
    if (envelope.type === MSG.instanceRegister) {
      const payload = envelope.payload as InstanceRegisterPayload;
      const presented = payload?.pairingToken ?? "";
      const viaLogin = this.deps.accounts.resolveLoginToken(presented);
      let result;
      if (viaLogin) {
        result = this.deps.instances.registerInstanceForAccount(
          viaLogin.account.id,
          payload?.name,
          payload?.coreVersion,
        );
      } else {
        const redeemed = this.deps.instances.redeemPairingToken(
          presented,
          payload?.coreVersion,
        );
        if (!redeemed) {
          this.logger.info(
            "relay.instance.handshake_failed",
            "handshake rejected",
            { reason: "pairing-failed" },
          );
          respond(
            errorPayload(
              "pairing-failed",
              "token is invalid, expired, or already used",
            ),
          );
          return null;
        }
        result = redeemed;
      }
      respond({ instanceId: result.instanceId, credential: result.credential });
      this.deps.instances.touch(
        result.instanceId,
        payload?.coreVersion,
        normalizeCapabilities(payload?.capabilities),
      );
      return { instanceId: result.instanceId, accountId: result.accountId };
    }
    if (envelope.type === MSG.instanceAuth) {
      const payload = envelope.payload as InstanceAuthPayload;
      const instance = this.deps.instances.verifyCredential(
        payload?.instanceId ?? "",
        payload?.credential ?? "",
      );
      if (!instance) {
        this.logger.info(
          "relay.instance.handshake_failed",
          "handshake rejected",
          { reason: "auth-failed" },
        );
        respond(
          errorPayload("auth-failed", "unknown instance or bad credential"),
        );
        socket.close(4403, "auth-failed");
        return null;
      }
      respond({ ok: true });
      this.deps.instances.touch(
        instance.id,
        payload?.coreVersion,
        normalizeCapabilities(payload?.capabilities),
      );
      return { instanceId: instance.id, accountId: instance.accountId };
    }
    this.logger.info("relay.instance.handshake_failed", "handshake rejected", {
      reason: "unknown-message-type",
    });
    socket.close(4401, "unauthenticated");
    return null;
  }

  /** Fire-and-forget downward event to a connector. No pending/timeout. Returns false if offline. */
  sendEvent(instanceId: string, type: string, payload: unknown): boolean {
    const connection = this.connections.get(instanceId);
    if (!connection) return false;
    connection.socket.send(
      encodeEnvelope({
        protocolVersion: RELAY_PROTOCOL_VERSION,
        kind: "event",
        type,
        payload,
      }),
    );
    return true;
  }

  /** Force-close the instance's current socket (e.g. after a failed recovery
   *  persistence transaction). The connector reconnects with backoff and re-sends its
   *  `instance.state.sync` on auth, so the entry that failed to persist gets another
   *  chance instead of sitting in the connector's FIFO until eviction.
   *
   *  The connection is REVOKED FIRST (map entry dropped, in-flight requests rejected,
   *  offline transition fired) and the socket closed only afterwards — the close
   *  handshake is async, and a socket that stayed in the map during it could keep
   *  delivering events (e.g. a late `turn-finished` that persists + acks, bypassing
   *  the reconnect/resync this disconnect was meant to force). The ownership check in
   *  handleMessage drops anything that still arrives on the revoked socket. */
  disconnect(instanceId: string): void {
    const connection = this.connections.get(instanceId);
    if (!connection) return;
    this.dropConnection(instanceId, connection.accountId);
    this.logger.info(
      "relay.instance.disconnected",
      "instance connection revoked (persist-failed)",
      { instanceId, accountId: connection.accountId },
    );
    try {
      connection.socket.close(4408, "persist-failed");
    } catch (err) {
      this.logger.debug(
        "relay.instance.disconnect_failed",
        "closing revoked instance socket failed",
        { instanceId, error: String(err) },
      );
    }
  }

  async sendRequest(
    instanceId: string,
    type: string,
    payload: unknown,
    options?: { timeoutMs?: number },
  ): Promise<unknown> {
    const connection = this.connections.get(instanceId);
    if (!connection) {
      throw new Error("instance-offline");
    }
    const id = `relay-${++this.seq}`;
    const timeoutMs =
      options?.timeoutMs ??
      this.deps.requestTimeoutMs ??
      DEFAULT_REQUEST_TIMEOUT_MS;
    const requestBudgetMs = Math.max(
      timeoutMs - REQUEST_RESPONSE_RESERVE_MS,
      1,
    );
    // This is the mutation work cutoff, not the Hub response timer. Keeping the
    // reserve in both representations prevents delivery latency from consuming it.
    const requestDeadlineAt = Date.now() + requestBudgetMs;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("timeout"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        instanceId,
        socket: connection.socket,
        type,
      });
      connection.socket.send(
        encodeEnvelope({
          protocolVersion: RELAY_PROTOCOL_VERSION,
          kind: "req",
          id,
          type,
          payload,
          requestDeadlineAt,
          requestBudgetMs,
        }),
      );
    });
  }

  /** Reject every pending RPC that went out over `socket` (used when the socket is
   *  superseded by a reconnect — the old connection's responses will never arrive, and
   *  waiting out the full request timeout would hang the HTTP call). Does NOT fire the
   *  offline transition: the new connection has already taken over the instance. */
  private rejectPendingForSocket(socket: GatewaySocket, reason: string): void {
    for (const [id, p] of this.pending) {
      if (p.socket === socket) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new Error(reason));
      }
    }
  }

  getPublishedEndpoints(accountId: string): PublishedAgentEndpointDto[] {
    const result: PublishedAgentEndpointDto[] = [];
    for (const [instId, conn] of this.connections) {
      if (conn.accountId === accountId) {
        const endpoints = this.endpointsByInstance.get(instId) ?? [];
        result.push(...endpoints);
      }
    }
    return result;
  }

  getWebPublishedEndpoints(accountId: string): WebAgentDirectoryEndpointDto[] {
    const result: WebAgentDirectoryEndpointDto[] = [];
    for (const [instId, conn] of this.connections) {
      if (conn.accountId === accountId) {
        const endpoints = this.endpointsByInstance.get(instId) ?? [];
        for (const ep of endpoints) {
          result.push({
            ...ep,
            instanceId: instId,
          });
        }
      }
    }
    return result;
  }

  private broadcastDirectorySnapshot(accountId: string): void {
    const endpoints = this.getPublishedEndpoints(accountId);
    const webEndpoints = this.getWebPublishedEndpoints(accountId);
    this.deps.onDirectoryChange?.(accountId, webEndpoints);
    for (const [instId, conn] of this.connections) {
      if (conn.accountId === accountId) {
        this.sendEvent(instId, MSG.agentDirectorySnapshot, { endpoints });
      }
    }
  }
}
