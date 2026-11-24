import { expect, test } from "bun:test";

import { MSG, decodeEnvelope } from "@ganglion/xacpx-relay-protocol";

import { createLocalWebApp } from "../../../../packages/channel-web/src/app";
import { LocalInteractions } from "../../../../packages/channel-web/src/interactions";

const headers = { host: "127.0.0.1:7890", "content-type": "application/json" };

test("an open form is sent as data the browser can read, and a late answer is refused", async () => {
  const frames: unknown[] = [];
  const interactions = new LocalInteractions(() => 1_000, () => 0 as never, () => undefined, (frame) => frames.push(frame));
  const pending = interactions.openElicitation({
    requestId: "ask-1",
    chatKey: "web:local",
    chatType: "direct",
    requester: { senderId: "local" },
    message: "Pick one",
    fields: [{ key: "note", kind: "text", title: "Note", required: true }],
    agent: { name: "codex", sessionAlias: "demo" },
    expiresAt: 5_000,
    signal: new AbortController().signal,
  } as never);
  expect(JSON.stringify(interactions.list())).toContain("ask-1");
  expect(frames[0]).toMatchObject({ type: "interaction-opened", interaction: { requestId: "ask-1", kind: "elicitation" } });

  const local = createLocalWebApp({
    config: { host: "127.0.0.1", port: 7890, terminal: { enabled: false } },
    port: 7890,
    control: { events: { subscribe: () => () => undefined } } as never,
    now: () => 1_000,
  });
  const sent: string[] = [];
  const opened = local.interactions.openPermission({
    requestId: "perm-1",
    chatKey: "web:local",
    requester: { senderId: "local" },
    toolCallId: "tool-1",
    availableOutcomes: ["allow_once", "cancel"],
    expiresAt: 5_000,
    signal: new AbortController().signal,
  });
  local.attach((data) => sent.push(data), () => undefined, undefined);
  const snapshot = decodeEnvelope(sent[0] ?? "");
  expect(snapshot.ok && snapshot.envelope.payload).toMatchObject({
    kind: "interaction-snapshot",
    interactions: [{ interaction: { requestId: "perm-1" } }],
  });

  const answer = await local.app.request("/api/instances/local/rpc", {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: MSG.interactionRespond,
      payload: { requestId: "perm-1", kind: "permission", action: "allow_once" },
    }),
  });
  expect(answer.status).toBe(200);
  await expect(opened).resolves.toMatchObject({ outcome: "allow_once", responderId: "local" });

  const again = await local.app.request("/api/instances/local/rpc", {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: MSG.interactionRespond,
      payload: { requestId: "perm-1", kind: "permission", action: "cancel" },
    }),
  });
  expect(again.status).toBe(409);
  void pending;
});
