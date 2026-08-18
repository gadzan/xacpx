import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, mock } from "bun:test";

import { ControlService } from "../../../src/control/control-service";
import { UploadStore } from "../../../src/control/upload-store";
import { createControlEventBus } from "../../../src/control/control-event-bus";

// Minimal deps stub — only what uploadFile/prompt() touch in this test.
function buildService(
  chatSpy: ReturnType<typeof mock>,
  uploadStore: UploadStore,
) {
  const events = createControlEventBus();
  const deps = {
    agent: { chat: chatSpy },
    sessions: {
      listAllResolvedSessions: () => [],
      resolveAliasForChat: mock(
        async (_chatKey: string, alias: string) => alias,
      ),
      getSession: mock(async (_alias: string) => ({
        alias: "main",
        agent: "claude",
        workspace: "ws",
        transportSession: "t",
        cwd: "/tmp",
        replyMode: "stream" as const,
        effectiveReplyMode: "stream" as const,
      })),
      useSession: mock(async (_chatKey: string, _alias: string) => ({
        alias: "main",
        agent: "claude",
        workspace: "ws",
      })),
      setSessionModel: mock(async () => {}),
    },
    activeTurns: { isActiveAnywhere: () => false },
    scheduled: {} as never,
    orchestration: {} as never,
    events,
    workspaces: { list: () => [] },
    transport: {} as never,
    createSessionWithTransport: mock(async () => {
      throw new Error("unused");
    }),
    removeSessionWithTransport: mock(async () => ({ wasActive: false })),
    archiveSessionWithTransport: mock(async () => {}),
    unarchiveSession: mock(async () => {}),
    listNativeSessions: mock(async () => []),
    attachNativeSessionWithTransport: mock(async () => {
      throw new Error("unused");
    }),
    agents: {
      list: () => [],
      catalog: () => [],
      create: mock(async () => {
        throw new Error("unused");
      }),
      remove: mock(async () => {}),
    },
    uploadStore,
  } as unknown as ConstructorParameters<typeof ControlService>[0];
  return new ControlService(deps);
}

describe("ControlService media", () => {
  it("uploadFile writes bytes and returns an absolute daemon path", async () => {
    const root = await mkdtemp(join(tmpdir(), "cs-upload-"));
    const store = new UploadStore({ rootDir: root });
    const svc = buildService(
      mock(() => {}),
      store,
    );

    const res = await svc.uploadFile({
      filename: "shot.png",
      content: Buffer.from("PNG").toString("base64"),
      mimeType: "image/png",
    });
    expect(res.path.startsWith(root)).toBe(true);
    expect(res.filename).toBe("shot.png");
    expect(res.size).toBe(3);
  });

  it("prompt() forwards media refs to agent.chat as ChannelMediaAttachment[]", async () => {
    const chat = mock(async () => ({ text: "ok" }));
    const root = await mkdtemp(join(tmpdir(), "cs-upload-"));
    const svc = buildService(chat, new UploadStore({ rootDir: root }));
    // Mirror the real web flow: the path echoed back is the one control.upload returned,
    // which lives under the sandbox root.
    const inSandbox = join(root, "u-1", "shot.png");

    await svc.prompt({
      chatKey: "relay:a1",
      sessionAlias: "main",
      text: "look at this",
      senderId: "a1",
      isOwner: true,
      media: [
        {
          id: "u-1",
          filePath: inSandbox,
          fileName: "shot.png",
          mimeType: "image/png",
          kind: "image",
          size: 3,
        },
      ],
    });

    expect(chat).toHaveBeenCalledTimes(1);
    const arg = (chat.mock.calls[0] as unknown[])[0] as {
      media: Array<Record<string, unknown> & { source: { channelId: string } }>;
    };
    expect(Array.isArray(arg.media)).toBe(true);
    expect(arg.media[0]).toMatchObject({
      kind: "image",
      filePath: inSandbox,
      mimeType: "image/png",
      fileName: "shot.png",
    });
    expect(arg.media[0].source.channelId).toBe("relay");
  });

  it("prompt() drops media refs whose filePath escapes the upload sandbox", async () => {
    const chat = mock(async () => ({ text: "ok" }));
    const root = await mkdtemp(join(tmpdir(), "cs-upload-"));
    const svc = buildService(chat, new UploadStore({ rootDir: root }));
    const inSandbox = join(root, "u-2", "ok.png");

    await svc.prompt({
      chatKey: "relay:a1",
      sessionAlias: "main",
      text: "look at this",
      senderId: "a1",
      isOwner: true,
      media: [
        // Out-of-sandbox absolute path — must be dropped.
        {
          id: "u-evil",
          filePath: "/etc/passwd",
          fileName: "passwd",
          mimeType: "text/plain",
          kind: "file",
          size: 3,
        },
        // Legitimate in-sandbox path — must pass through.
        {
          id: "u-2",
          filePath: inSandbox,
          fileName: "ok.png",
          mimeType: "image/png",
          kind: "image",
          size: 3,
        },
      ],
    });

    expect(chat).toHaveBeenCalledTimes(1);
    const arg = (chat.mock.calls[0] as unknown[])[0] as {
      media: Array<Record<string, unknown>>;
    };
    expect(arg.media.length).toBe(1);
    expect(arg.media[0]).toMatchObject({ kind: "image", filePath: inSandbox });
  });
});
