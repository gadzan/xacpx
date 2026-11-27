import { describe, expect, test } from "bun:test";

import { MSG, RELAY_CAPABILITIES } from "@ganglion/xacpx-relay-protocol";

import { createLocalWebApp } from "../../../../packages/channel-web/src/app";

function control(seen: Array<Record<string, unknown>> = []) {
  return {
    events: { subscribe: () => () => undefined },
    sessions: { list: async (input: Record<string, unknown>) => (seen.push(input), []) },
    prompt: async (input: Record<string, unknown>) => {
      seen.push(input);
      return { accepted: true };
    },
  };
}

function app(token?: string) {
  return createLocalWebApp({
    config: { host: "127.0.0.1", port: 7138, terminal: { enabled: false }, ...(token ? { token } : {}) },
    port: 7138,
    control: control() as never,
  }).app;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { host: "127.0.0.1:7138", ...extra };
}

describe("local web app", () => {
  test("publishes the local host config without a login", async () => {
    const response = await app().request("/api/config", { headers: headers() });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.hostMode).toBe("local");
    expect(body.auth.required).toBe(false);
    expect(body.defaultInstanceId).toBe("local");
    expect(body.capabilities.terminal).toBe(false);
    expect(body.capabilities.desktop).toBe(false);
  });

  test("rejects a foreign host and a foreign origin", async () => {
    const host = await app().request("/api/config", { headers: { host: "evil.example:7138" } });
    expect(host.status).toBe(403);
    const origin = await app().request("/api/login", {
      method: "POST",
      headers: headers({ origin: "https://evil.example", "content-type": "application/json" }),
      body: "{}",
    });
    expect(origin.status).toBe(403);
  });

  test("rejects a form post", async () => {
    const response = await app().request("/api/login", {
      method: "POST",
      headers: headers({ "content-type": "application/x-www-form-urlencoded" }),
      body: "token=x",
    });
    expect(response.status).toBe(415);
  });

  test("a token stays in an http-only cookie", async () => {
    const local = createLocalWebApp({
      config: { host: "127.0.0.1", port: 7138, token: "secret", terminal: { enabled: false } },
      port: 7138,
      control: control() as never,
    });
    const denied = await local.app.request("/api/me", { headers: headers() });
    expect(denied.status).toBe(401);
    const login = await local.app.request("/api/login", {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ token: "secret" }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie") ?? "";
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie.toLowerCase()).toContain("samesite=strict");
    expect(cookie).not.toContain("secret");
    const session = cookie.split(";", 1)[0] ?? "";
    const me = await local.app.request("/api/me", { headers: headers({ cookie: session }) });
    expect(me.status).toBe(200);
  });

  test("stamps the local chat scope before a browser prompt reaches core", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const local = createLocalWebApp({
      config: { host: "127.0.0.1", port: 7138, terminal: { enabled: false } },
      port: 7138,
      control: control(seen) as never,
    });
    const response = await local.app.request("/api/instances/local/rpc", {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "demo", text: "hello" } }),
    });
    expect(response.status).toBe(200);
    expect(seen[0]).toMatchObject({
      chatKey: "web:local",
      senderId: "local",
      isOwner: true,
      chatType: "direct",
      sessionAlias: "demo",
      text: "hello",
    });
    const history = await local.app.request("/api/instances/local/sessions/demo/messages", { headers: headers() });
    const body = await history.json();
    expect(body.messages.map((row: { text: string }) => row.text)).toEqual(["hello"]);
  });

  test("stamps the local owner on a direct conversation prompt", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const local = createLocalWebApp({
      config: { host: "127.0.0.1", port: 7138, terminal: { enabled: false } },
      port: 7138,
      control: { events: { subscribe: () => () => undefined } } as never,
      trustedConversationPrompt: async (input, ingress) => {
        seen.push({ ...input, humanIngress: ingress });
        return { accepted: true };
      },
    });
    const response = await local.app.request("/api/instances/local/rpc", {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ type: MSG.conversationPrompt, payload: { conversationId: "c1", topicId: "t1", text: "hello" } }),
    });
    expect(response.status).toBe(200);
    expect(seen[0]?.humanIngress).toMatchObject({
      chatKey: "web:local",
      senderId: "local",
      accountId: "local",
      isOwner: true,
      chatType: "direct",
    });
  });

  test("reports the terminal only when it actually started", async () => {
    const local = createLocalWebApp({
      config: { host: "127.0.0.1", port: 7138, terminal: { enabled: true } },
      port: 7138,
      control: control() as never,
      terminal: { ready: false, handle: async () => undefined, detachViewer: () => undefined },
    });
    const response = await local.app.request("/api/config", { headers: headers() });
    expect((await response.json()).capabilities.terminal).toBe(false);
  });

  test("advertises the timeline when the core provides it", async () => {
    const local = createLocalWebApp({
      config: { host: "127.0.0.1", port: 7138, terminal: { enabled: false } },
      port: 7138,
      control: {
        events: { subscribe: () => () => undefined },
        supportsConversationTimelineV1: () => true,
      } as never,
    });
    const response = await local.app.request("/api/instances", { headers: headers() });
    const [instance] = (await response.json()).instances;
    // The dashboard shows an upgrade notice and disables writes without this.
    expect(instance.capabilities).toContain(RELAY_CAPABILITIES.conversationTimelineV1);
  });

  test("offers no timeline when the core cannot answer for it", async () => {
    const local = createLocalWebApp({
      config: { host: "127.0.0.1", port: 7138, terminal: { enabled: false } },
      port: 7138,
      control: { events: { subscribe: () => () => undefined } } as never,
    });
    const response = await local.app.request("/api/instances", { headers: headers() });
    const [instance] = (await response.json()).instances;
    expect(instance.capabilities).not.toContain(RELAY_CAPABILITIES.conversationTimelineV1);
  });

  test("offers a dedicated Bot workspace when the core allocates one", async () => {
    const local = createLocalWebApp({
      config: { host: "127.0.0.1", port: 7138, terminal: { enabled: false } },
      port: 7138,
      control: {
        events: { subscribe: () => () => undefined },
        supportsBotDedicatedWorkspace: () => true,
        supportsBotDedicatedWorkspaceUpdate: () => true,
        supportsBotDedicatedWorkspaceCleanup: () => true,
      } as never,
    });
    const response = await local.app.request("/api/instances", { headers: headers() });
    const [instance] = (await response.json()).instances;
    // Without these the create dialog asks the user to pick a workspace, which is
    // how two Bots could end up sharing one tree.
    expect(instance.capabilities).toContain(RELAY_CAPABILITIES.botsDedicatedWorkspaceV1);
    expect(instance.capabilities).toContain(RELAY_CAPABILITIES.botsDedicatedWorkspaceUpdateV1);
    expect(instance.capabilities).toContain(RELAY_CAPABILITIES.botsDedicatedWorkspaceCleanupV1);
  });

  test("offers no dedicated Bot workspace when the core predates it", async () => {
    const local = createLocalWebApp({
      config: { host: "127.0.0.1", port: 7138, terminal: { enabled: false } },
      port: 7138,
      control: { events: { subscribe: () => () => undefined } } as never,
    });
    const response = await local.app.request("/api/instances", { headers: headers() });
    const [instance] = (await response.json()).instances;
    // An older core still requires `workspace` on create, so the picker must stay.
    expect(instance.capabilities).not.toContain(RELAY_CAPABILITIES.botsDedicatedWorkspaceV1);
  });

  test("keeps a prompt that starts before the queue reply is known", async () => {
    let finish: (value: unknown) => void = () => undefined;
    let reached: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    const local = createLocalWebApp({
      config: { host: "127.0.0.1", port: 7138, terminal: { enabled: false } },
      port: 7138,
      control: {
        events: { subscribe: () => () => undefined },
        prompt: () => {
          reached();
          return new Promise((resolve) => { finish = resolve; });
        },
      } as never,
    });
    const sent = local.app.request("/api/instances/local/rpc", {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "demo", text: "hello" } }),
    });
    await waiting;
    local.project({ type: "turn-started", chatKey: "web:local", sessionAlias: "demo", queueItemId: "q1" });
    local.project({ type: "turn-finished", chatKey: "web:local", sessionAlias: "demo", ok: true, text: "done" });
    finish({ queued: true, queueItemId: "q1" });
    expect((await sent).status).toBe(200);
    const history = await local.app.request("/api/instances/local/sessions/demo/messages", { headers: headers() });
    expect((await history.json()).messages.map((row: { text: string }) => row.text)).toEqual(["hello", "done"]);
  });

  test("queues a prompt whose turn started before the reply arrived", async () => {
    let finish: (value: unknown) => void = () => undefined;
    let reached: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    const local = createLocalWebApp({
      config: { host: "127.0.0.1", port: 7138, terminal: { enabled: false } },
      port: 7138,
      control: {
        events: { subscribe: () => () => undefined },
        prompt: () => {
          reached();
          return new Promise((resolve) => { finish = resolve; });
        },
      } as never,
    });
    const sent = local.app.request("/api/instances/local/rpc", {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "demo", text: "hello" } }),
    });
    await waiting;
    local.project({ type: "turn-started", chatKey: "web:local", sessionAlias: "demo", queueItemId: "q1" });
    finish({ queued: true, queueItemId: "q1" });
    expect((await sent).status).toBe(200);
    // The early start was remembered, so this prompt is not queued again.
    const pending = await local.app.request("/api/instances/local/sessions/demo/messages?view=pending", { headers: headers() });
    expect((await pending.json()).items).toEqual([]);
    // The reply claimed it: nothing is left behind for the life of the daemon.
    expect(local.earlyTurns()).toEqual([]);
  });

  test("removes a queued prompt only when cancellation succeeds", async () => {
    const local = createLocalWebApp({
      config: { host: "127.0.0.1", port: 7138, terminal: { enabled: false } },
      port: 7138,
      control: {
        events: { subscribe: () => () => undefined },
        prompt: async () => ({ queued: true, queueItemId: "q1" }),
        cancelQueuedItem: async () => ({ cancelled: false }),
      } as never,
    });
    await local.app.request("/api/instances/local/rpc", {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "demo", text: "wait" } }),
    });
    const failed = await local.app.request("/api/instances/local/rpc", {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ type: MSG.queueCancel, payload: { sessionAlias: "demo", itemId: "q1" } }),
    });
    expect(failed.status).toBe(200);
    const pending = await local.app.request("/api/instances/local/sessions/demo/messages?view=pending", { headers: headers() });
    expect((await pending.json()).items).toHaveLength(1);
  });

  test("seeds recovered history once and keeps its structure", async () => {
    const local = createLocalWebApp({
      config: { host: "127.0.0.1", port: 7138, terminal: { enabled: false } },
      port: 7138,
      control: control() as never,
    });
    const seed = {
      type: "session-history" as const,
      chatKey: "web:local",
      sessionAlias: "demo",
      messages: [{ direction: "in" as const, text: "earlier", structured: { reasoning: "why" } }],
    };
    local.project(seed);
    local.project(seed);
    const history = await local.app.request("/api/instances/local/sessions/demo/messages", { headers: headers() });
    const rows = (await history.json()).messages as Array<{ text: string; structured?: { reasoning?: string } }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.structured?.reasoning).toBe("why");
  });

  test("a history read off the daemon carries the agent's process, not just its text", async () => {
    const local = createLocalWebApp({
      config: { host: "127.0.0.1", port: 7138, terminal: { enabled: false } },
      port: 7138,
      control: {
        events: { subscribe: () => () => undefined },
        readSessionHistory: async () => ({
          hasMore: false,
          messages: [{
            role: "agent",
            text: "done",
            parts: [
              { kind: "reasoning", text: "weighing options" },
              { kind: "tool", tool: { toolCallId: "t1", toolName: "Read", kind: "read", status: "success", title: "a.ts" } },
              { kind: "text", text: "done" },
            ],
          }],
        }),
      } as never,
    });
    const history = await local.app.request("/api/instances/local/sessions/demo/messages", { headers: headers() });
    const rows = (await history.json()).messages as Array<{
      text: string;
      structured?: { parts?: Array<{ type: string }>; toolSteps?: Array<{ toolName: string }>; reasoning?: string };
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.structured?.parts?.map((p) => p.type)).toEqual(["reasoning", "tool", "text"]);
    expect(rows[0]?.structured?.toolSteps?.[0]?.toolName).toBe("Read");
    expect(rows[0]?.structured?.reasoning).toBe("weighing options");
  });

  test("two history reads racing on an empty store append the backlog once", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const local = createLocalWebApp({
      config: { host: "127.0.0.1", port: 7138, terminal: { enabled: false } },
      port: 7138,
      control: {
        events: { subscribe: () => () => undefined },
        readSessionHistory: async () => {
          await gate;
          return { hasMore: false, messages: [{ role: "agent" as const, text: "answer", parts: [{ kind: "text" as const, text: "answer" }] }] };
        },
      } as never,
    });
    // Both requests observe an empty store and both reach the daemon before either
    // installs, which is exactly the window that used to duplicate every row.
    const first = local.app.request("/api/instances/local/sessions/demo/messages", { headers: headers() });
    const second = local.app.request("/api/instances/local/sessions/demo/messages", { headers: headers() });
    release?.();
    const [a, b] = await Promise.all([first, second]);
    expect(((await a.json()).messages as Array<{ text: string }>).map((r) => r.text)).toEqual(["answer"]);
    expect(((await b.json()).messages as Array<{ text: string }>).map((r) => r.text)).toEqual(["answer"]);
  });

  test("keeps a rejected prompt out of history", async () => {
    const local = createLocalWebApp({
      config: { host: "127.0.0.1", port: 7138, terminal: { enabled: false } },
      port: 7138,
      control: { events: { subscribe: () => () => undefined }, prompt: async () => ({ error: { code: "bad-request", message: "no" } }) } as never,
    });
    const response = await local.app.request("/api/instances/local/rpc", {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ type: MSG.prompt, payload: { sessionAlias: "demo", text: "hello" } }),
    });
    expect(response.status).toBe(400);
    const history = await local.app.request("/api/instances/local/sessions/demo/messages", { headers: headers() });
    expect((await history.json()).messages).toEqual([]);
  });

  test("a live turn is still there after a refresh and lands in history when it finishes", async () => {
    const local = createLocalWebApp({
      config: { host: "127.0.0.1", port: 7138, terminal: { enabled: false } },
      port: 7138,
      control: control() as never,
      now: () => 1_700_000_000_000,
    });
    local.project({ type: "turn-started", chatKey: "web:local", sessionAlias: "demo" });
    local.project({ type: "turn-output", chatKey: "web:local", sessionAlias: "demo", chunk: "hi" });
    const live = await local.app.request("/api/active-turns", { headers: headers() });
    expect((await live.json()).turns[0]).toMatchObject({ sessionAlias: "demo", status: "streaming" });
    local.project({ type: "turn-finished", chatKey: "web:local", sessionAlias: "demo", ok: true, text: "hi there" });
    const history = await local.app.request("/api/instances/local/sessions/demo/messages", { headers: headers() });
    expect((await history.json()).messages.map((row: { direction: string; text: string }) => `${row.direction}:${row.text}`))
      .toContain("out:hi there");
    expect((await (await local.app.request("/api/active-turns", { headers: headers() })).json()).turns).toEqual([]);
  });
});
