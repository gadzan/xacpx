import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";

import { MSG } from "../../packages/relay-protocol/src/index";
import { createControlBridge, subscribeControlEvents } from "../../packages/channel-relay/src/control-bridge";
import { CredentialStore } from "../../packages/channel-relay/src/credential-store";
import { RelayClient } from "../../packages/channel-relay/src/relay-client";
import { startRelayServer } from "../../packages/relay/src/server";
import { createDirectConversationId, createDirectTopicId } from "../../src/domain/ids";
import { asPublicControl } from "../../src/control/public-control";
import { wirePr8Acceptance } from "./helpers/pr8-wire";

const ARTIFACT_DIR = process.env.PR8_ARTIFACT_DIR ?? "/opt/cursor/artifacts/pr8";

type Layer = "control" | "relay" | "web";
type StepStatus = "measured" | "skipped" | "failed";

interface AcceptanceStep {
  id: string;
  layer: Layer;
  status: StepStatus;
  detail?: string;
}

const steps: AcceptanceStep[] = [];

function record(id: string, layer: Layer, status: StepStatus, detail?: string): void {
  steps.push({ id, layer, status, ...(detail ? { detail } : {}) });
}

async function relayRpc(
  base: string,
  cookie: string,
  instanceId: string,
  type: string,
  payload: Record<string, unknown> = {},
): Promise<unknown> {
  const res = await fetch(`${base}/api/instances/${instanceId}/rpc`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type, payload }),
  });
  const body = await res.json() as { result?: unknown; error?: unknown };
  if (!res.ok) throw new Error(JSON.stringify(body));
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}

function flushArtifacts(): void {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(join(ARTIFACT_DIR, "steps.json"), `${JSON.stringify({ recordedAt: new Date().toISOString(), steps }, null, 2)}\n`);
}

test("PR8 bot/group beta acceptance (Control → Relay)", async () => {
  const stack = await wirePr8Acceptance();
  const publicControl = asPublicControl(stack.control);
  let relay: Awaited<ReturnType<typeof startRelayServer>> | undefined;
  let relayCookie = "";
  let instanceId = "";
  let relayBase = "";
  let relayController: AbortController | undefined;

  try {
    if (stack.control.listBots().length === 0) {
      record("zero_data_bots", "control", "measured");
    } else {
      record("zero_data_bots", "control", "failed", "expected empty bot list");
    }

    relay = await startRelayServer({ dbPath: ":memory:", httpPort: 0, wsPort: 0, host: "127.0.0.1" });
    relayBase = `http://127.0.0.1:${relay.httpPort}`;
    const account = relay.runtime.accounts.createAccount("pr8");
    const { token: loginToken } = relay.runtime.accounts.createLoginToken(account.id);
    const login = await fetch(`${relayBase}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: loginToken }),
    });
    relayCookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const tokenRes = await fetch(`${relayBase}/api/instances/pairing-token`, {
      method: "POST",
      headers: { cookie: relayCookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "pr8-instance" }),
    });
    const { token } = (await tokenRes.json()) as { token: string };
    const credentialPath = join(mkdtempSync(join(tmpdir(), "xacpx-pr8-relay-")), "credential.json");
    relayController = new AbortController();
    await new Promise<void>((resolve) => {
      const client = new RelayClient({
        url: `ws://127.0.0.1:${relay.wsPort}`,
        credentialStore: new CredentialStore(credentialPath),
        pairingToken: token,
        coreVersion: "0.24.0",
        onRequest: createControlBridge(publicControl as never),
        onReady: resolve,
        reconnectDelaysMs: [0],
      });
      subscribeControlEvents(publicControl as never, (type, payload) => client.sendEvent(type, payload));
      client.start(relayController.signal);
    });
    const listRes = await fetch(`${relayBase}/api/instances`, { headers: { cookie: relayCookie } });
    const { instances } = (await listRes.json()) as { instances: Array<{ id: string }> };
    instanceId = instances[0]!.id;
    record("relay_pairing", "relay", "measured");

    const relayBots = await relayRpc(relayBase, relayCookie, instanceId, MSG.botsList, {}) as { bots: unknown[] };
    if (relayBots.bots.length === 0) {
      record("zero_data_bots", "relay", "measured");
    } else {
      record("zero_data_bots", "relay", "failed", "expected empty bots via relay");
    }

    const botA = await stack.control.createBot({ name: "Alpha", agent: "codex", workspace: "backend" });
    const botB = await stack.control.createBot({ name: "Beta", agent: "codex", workspace: "backend" });
    expect(stack.control.listBots()).toHaveLength(2);
    record("create_two_bots", "control", "measured");

    const relayAfterCreate = await relayRpc(relayBase, relayCookie, instanceId, MSG.botsList, {}) as { bots: Array<{ id: string }> };
    if (relayAfterCreate.bots.length === 2) {
      record("create_two_bots", "relay", "measured");
    } else {
      record("create_two_bots", "relay", "failed", `count=${relayAfterCreate.bots.length}`);
    }

    const instructions = "Ship the beta checklist.";
    await stack.control.updateBot(botA.id, { instructions });
    const reopened = stack.control.getBot(botA.id);
    if (reopened.instructions === instructions) {
      record("instructions_roundtrip", "control", "measured");
    } else {
      record("instructions_roundtrip", "control", "failed", `got ${reopened.instructions ?? ""}`);
    }

    const group = await stack.control.createGroup({ title: "Beta Squad", botIds: [botA.id, botB.id], leadBotId: botA.id });
    const topic = await stack.control.createGroupTopic(group.id, "Sprint", {
      workspace: "backend",
      isolation: "shared-single-writer",
    });
    record("create_group_topic", "control", "measured");

    const leadAccepted = await stack.control.promptConversation({
      conversationId: group.id,
      topicId: topic.id,
      requestId: "pr8-lead",
      text: "lead task",
      target: { botId: botA.id },
    });
    record("prompt_lead", "control", "measured");

    const membersAccepted = await stack.control.promptConversation({
      conversationId: group.id,
      topicId: topic.id,
      requestId: "pr8-members",
      text: "member task",
      target: { mode: "members", botIds: [botA.id, botB.id] },
    });
    record("prompt_members", "control", "measured");

    for (const runId of [leadAccepted.run.id, membersAccepted.run.id]) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const state = stack.control.getRun(runId).state;
        if (state === "completed" || state === "cancelled" || state === "failed") break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const finalState = stack.control.getRun(runId).state;
      if (finalState === "queued" || finalState === "running" || finalState === "waiting-human") {
        await stack.control.cancelRun(runId);
      }
    }

    record("public_handoff", "control", "skipped", "needs live member-turn mock runner (not run in PR8 harness)");

    const refreshed = stack.control.getGroup(group.id);
    if (refreshed.topics.some((row) => row.id === topic.id)) {
      record("refresh_group", "control", "measured");
    } else {
      record("refresh_group", "control", "failed");
    }

    const renamed = await stack.control.updateTopic(group.id, topic.id, "Sprint renamed");
    expect(renamed.title).toBe("Sprint renamed");
    const archived = await stack.control.archiveTopic(group.id, topic.id);
    expect(archived.status).toBe("archived");
    const restored = await stack.control.restoreTopic(group.id, topic.id);
    expect(restored.status).toBe("active");
    const extraTopic = await stack.control.createGroupTopic(group.id, "Scratch", {
      workspace: "backend",
      isolation: "shared",
    });
    await stack.control.teardownTopic(group.id, extraTopic.id, { requestId: "pr8-teardown" });
    const directConv = createDirectConversationId(botA.id);
    const directTopic = createDirectTopicId(botA.id);
    await stack.control.clearTopic(directConv, directTopic, { requestId: "pr8-clear-direct", confirm: true });
    record("topic_lifecycle", "control", "measured");

    await stack.control.updateBot(botB.id, { enabled: false });
    const disabled = stack.control.getBot(botB.id);
    await stack.control.updateBot(botB.id, { enabled: true });
    const enabled = stack.control.getBot(botB.id);
    if (!disabled.enabled && enabled.enabled) {
      record("disable_enable_bot", "control", "measured");
    } else {
      record("disable_enable_bot", "control", "failed");
    }

    const preview = await stack.control.previewBotRemoval(botA.id);
    if (preview.revision) {
      record("preview_removal", "control", "measured");
    } else {
      record("preview_removal", "control", "failed");
    }

    const availability = stack.runtime.routerAvailability;
    if (availability.status !== "ready") {
      record("router_default_off", "control", "measured", availability.status);
    } else {
      record("router_default_off", "control", "failed", "router reported ready without restricted binary");
    }

    await expect(stack.control.promptConversation({
      conversationId: group.id,
      topicId: topic.id,
      requestId: "pr8-automatic",
      text: "auto",
      target: { mode: "automatic" },
    })).rejects.toMatchObject({ code: "automatic_unsupported" });
    record("automatic_target_rejected", "control", "measured");

    await stack.control.promptConversation({
      conversationId: directConv,
      topicId: directTopic,
      requestId: "pr8-direct",
      text: "hello direct",
    });
    record("direct_prompt", "control", "measured");

    record("web_ui_walkthrough", "web", "skipped", "Playwright mock-hub has no honest bot/group RPC surface yet");

    const relayGroupList = await relayRpc(relayBase, relayCookie, instanceId, MSG.groupsList, {}) as { groups: Array<{ id: string }> };
    if (relayGroupList.groups.some((g) => g.id === group.id)) {
      record("refresh_group", "relay", "measured");
    } else {
      record("refresh_group", "relay", "failed");
    }
  } catch (err: unknown) {
    record("harness_exception", "control", "failed", err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    flushArtifacts();
    relayController?.abort();
    if (relay) await relay.close();
    await stack.runtime.shutdown();
  }
});
