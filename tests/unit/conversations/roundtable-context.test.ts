import { expect, test } from "bun:test";

import { harness, until } from "./fixtures/concurrency-harness";

test("a roundtable speaker receives the earlier speakers' public speech", async () => {
  const h = await harness();
  try {
    const { group, topic } = await h.group();
    const speakers = h.ids.slice(0, 2);
    const accepted = h.acceptRoundtable(group.id, topic.id, speakers, 1);
    const drain = h.dispatcher.kick();
    await until(() => h.runner.calls.length === 1);
    expect(h.runner.calls[0]!.text).not.toContain("first speaker analysis");
    h.runner.finish(0, { status: "completed", text: "first speaker analysis" });
    await until(() => h.runner.calls.length === 2);
    expect(h.runner.calls[1]!.text).toContain("first speaker analysis");
    expect(h.runner.calls[1]!.text).toContain("Discuss the rollout");
    h.runner.finish(1, { status: "completed", text: "second speaker analysis" });
    await drain;
    expect(h.store.getRun(accepted.run.id)?.state).toBe("completed");
  } finally {
    h.store.close();
  }
});

test("an earlier speaker's public group_say remark reaches the next speaker", async () => {
  const h = await harness();
  try {
    const { group, topic } = await h.group();
    const speakers = h.ids.slice(0, 2);
    h.acceptRoundtable(group.id, topic.id, speakers, 1);
    const drain = h.dispatcher.kick();
    await until(() => h.runner.calls.length === 1);
    const first = h.runner.calls[0]!;
    h.store.appendGroupSay({
      senderMemberTurnId: first.memberTurnId,
      sourceTurnId: first.sourceTurnId!,
      invocationId: "say-1",
      text: "progress remark from alpha",
      now: h.now().toISOString(),
    });
    h.runner.finish(0, { status: "completed", text: "alpha conclusion" });
    await until(() => h.runner.calls.length === 2);
    expect(h.runner.calls[1]!.text).toContain("progress remark from alpha");
    expect(h.runner.calls[1]!.text).toContain("alpha conclusion");
    h.runner.finish(1, { status: "completed", text: "beta conclusion" });
    await drain;
  } finally {
    h.store.close();
  }
});

test("a pass adds no phantom speech to the next speaker's context", async () => {
  const h = await harness();
  try {
    const { group, topic } = await h.group();
    const speakers = h.ids.slice(0, 2);
    h.acceptRoundtable(group.id, topic.id, speakers, 1);
    const drain = h.dispatcher.kick();
    await until(() => h.runner.calls.length === 1);
    const first = h.runner.calls[0]!;
    h.store.appendGroupSay({
      senderMemberTurnId: first.memberTurnId,
      sourceTurnId: first.sourceTurnId!,
      invocationId: "say-pass",
      text: "pass progress remark",
      now: h.now().toISOString(),
    });
    h.runner.finish(0, { status: "completed", text: "(pass)" });
    await until(() => h.runner.calls.length === 2);
    expect(h.runner.calls[1]!.text).not.toContain("pass progress remark");
    expect(h.runner.calls[1]!.text).not.toContain(`Bot ${speakers[0]}:`);
    h.runner.finish(1, { status: "completed", text: "(pass)" });
    await drain;
  } finally {
    h.store.close();
  }
});

test("a later round reads everyone from every earlier round, in speaking order", async () => {
  const h = await harness();
  try {
    const { group, topic } = await h.group();
    const speakers = h.ids.slice(0, 2);
    h.acceptRoundtable(group.id, topic.id, speakers, 2);
    const drain = h.dispatcher.kick();
    await until(() => h.runner.calls.length === 1);
    h.runner.finish(0, { status: "completed", text: "round one alpha" });
    await until(() => h.runner.calls.length === 2);
    expect(h.runner.calls[1]!.text).toContain("round one alpha");
    h.runner.finish(1, { status: "completed", text: "round one beta" });
    await until(() => h.runner.calls.length === 3);
    const third = h.runner.calls[2]!.text;
    expect(third).toContain("round one alpha");
    expect(third).toContain("round one beta");
    expect(third.indexOf("round one alpha")).toBeLessThan(third.indexOf("round one beta"));
    h.runner.finish(2, { status: "completed", text: "round two alpha" });
    await until(() => h.runner.calls.length === 4);
    const fourth = h.runner.calls[3]!.text;
    expect(fourth).toContain("round one alpha");
    expect(fourth).toContain("round one beta");
    expect(fourth).toContain("round two alpha");
    expect(fourth.indexOf("round one beta")).toBeLessThan(fourth.indexOf("round two alpha"));
    h.runner.finish(3, { status: "completed", text: "round two beta" });
    await drain;
  } finally {
    h.store.close();
  }
});
