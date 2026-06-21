import { expect, test } from "bun:test";

import { parseCommand } from "../../../src/commands/parse-command";

test("parses session creation flags", () => {
  expect(parseCommand("/session new api-fix --agent codex --ws backend")).toEqual({
    kind: "session.new",
    alias: "api-fix",
    agent: "codex",
    workspace: "backend",
  });
});

test("parses help commands with and without topics", () => {
  expect(parseCommand("/help")).toEqual({
    kind: "help",
  });
  expect(parseCommand("/help ss")).toEqual({
    kind: "help",
    topic: "ss",
  });
  expect(parseCommand("/help workspace")).toEqual({
    kind: "help",
    topic: "workspace",
  });
});

test("parses session creation aliases", () => {
  expect(parseCommand("/ss new api-fix -a codex --ws backend")).toEqual({
    kind: "session.new",
    alias: "api-fix",
    agent: "codex",
    workspace: "backend",
  });
});

test("parses session creation with the short workspace flag variant", () => {
  expect(parseCommand("/ss new api-fix -a codex -ws backend")).toEqual({
    kind: "session.new",
    alias: "api-fix",
    agent: "codex",
    workspace: "backend",
  });
});

test("parses the session shortcut command", () => {
  expect(parseCommand("/ss codex -d E:/projects/weacpx")).toEqual({
    kind: "session.shortcut",
    agent: "codex",
    cwd: "E:/projects/weacpx",
  });
});

test("parses the session shortcut command with a workspace name", () => {
  expect(parseCommand("/ss codex --ws weacpx")).toEqual({
    kind: "session.shortcut",
    agent: "codex",
    workspace: "weacpx",
  });
});

test("parses the explicit session shortcut create command", () => {
  expect(parseCommand('/ss new codex -d "E:/projects/weacpx"')).toEqual({
    kind: "session.shortcut.new",
    agent: "codex",
    cwd: "E:/projects/weacpx",
  });
});

test("parses the explicit session shortcut create command with a workspace name", () => {
  expect(parseCommand("/ss new codex --ws weacpx")).toEqual({
    kind: "session.shortcut.new",
    agent: "codex",
    workspace: "weacpx",
  });
});

test("parses session attach flags", () => {
  expect(
    parseCommand("/session attach review --agent codex --ws backend --name existing-review"),
  ).toEqual({
    kind: "session.attach",
    alias: "review",
    agent: "codex",
    workspace: "backend",
    transportSession: "existing-review",
  });
});

test("parses session attach aliases", () => {
  expect(parseCommand("/ss attach review -a codex --ws backend --name existing-review")).toEqual({
    kind: "session.attach",
    alias: "review",
    agent: "codex",
    workspace: "backend",
    transportSession: "existing-review",
  });
});

test("parses session attach with the short workspace flag variant", () => {
  expect(parseCommand("/ss attach review -a codex -ws backend --name existing-review")).toEqual({
    kind: "session.attach",
    alias: "review",
    agent: "codex",
    workspace: "backend",
    transportSession: "existing-review",
  });
});

test("parses native session list commands", () => {
  expect(parseCommand("/ssn")).toEqual({ kind: "session.native.list" });
  expect(parseCommand("/ss native")).toEqual({ kind: "session.native.list" });
  expect(parseCommand("/ssn --all")).toEqual({ kind: "session.native.list", all: true });
  expect(parseCommand("/ssn codex --ws project")).toEqual({
    kind: "session.native.list",
    agent: "codex",
    workspace: "project",
  });
  expect(parseCommand("/ssn codex -d /Users/me/project")).toEqual({
    kind: "session.native.list",
    agent: "codex",
    cwd: "/Users/me/project",
  });
});

test("parses native session select and attach commands", () => {
  expect(parseCommand("/ssn 1")).toEqual({ kind: "session.native.select", identifier: "1" });
  expect(parseCommand("/ssn attach 1")).toEqual({ kind: "session.native.attach", identifier: "1" });
  expect(parseCommand("/ss attach native 1")).toEqual({ kind: "session.native.attach", identifier: "1" });
  expect(parseCommand("/ssn attach 019e5d48 -a fix-ci")).toEqual({
    kind: "session.native.attach",
    identifier: "019e5d48",
    alias: "fix-ci",
  });
  expect(parseCommand("/ss attach native 019e5d48 --alias fix-ci")).toEqual({
    kind: "session.native.attach",
    identifier: "019e5d48",
    alias: "fix-ci",
  });
});

test("parses native session select with an alias", () => {
  expect(parseCommand("/ssn 1 -a fix-ci")).toEqual({
    kind: "session.native.select",
    identifier: "1",
    alias: "fix-ci",
  });
  expect(parseCommand("/ssn 2 --alias fix-ci")).toEqual({
    kind: "session.native.select",
    identifier: "2",
    alias: "fix-ci",
  });
  // bare numeric select still carries no alias
  expect(parseCommand("/ssn 1")).toEqual({ kind: "session.native.select", identifier: "1" });
  // trailing junk after the number is still invalid
  expect(parseCommand("/ssn 1 2")).toEqual({ kind: "invalid", text: "/ssn 1 2", recognizedCommand: "/ssn" });
});

test("rejects native session list flags with missing values", () => {
  expect(parseCommand("/ssn --cursor --all")).toEqual({
    kind: "invalid",
    text: "/ssn --cursor --all",
    recognizedCommand: "/ssn",
  });
  expect(parseCommand("/ssn --cwd --all")).toEqual({
    kind: "invalid",
    text: "/ssn --cwd --all",
    recognizedCommand: "/ssn",
  });
  expect(parseCommand("/ssn codex --ws -d")).toEqual({
    kind: "invalid",
    text: "/ssn codex --ws -d",
    recognizedCommand: "/ssn",
  });
});

test("rejects native session attach flags with missing or flag-like values", () => {
  expect(parseCommand("/ssn attach")).toEqual({
    kind: "invalid",
    text: "/ssn attach",
    recognizedCommand: "/ssn",
  });
  expect(parseCommand("/ss attach native")).toEqual({
    kind: "invalid",
    text: "/ss attach native",
    recognizedCommand: "/session",
  });
  expect(parseCommand("/ssn attach --alias")).toEqual({
    kind: "invalid",
    text: "/ssn attach --alias",
    recognizedCommand: "/ssn",
  });
  expect(parseCommand("/ssn attach 1 --alias --foo")).toEqual({
    kind: "invalid",
    text: "/ssn attach 1 --alias --foo",
    recognizedCommand: "/ssn",
  });
});

test("parses use command", () => {
  expect(parseCommand("/use api-fix")).toEqual({
    kind: "session.use",
    alias: "api-fix",
  });
});

test("parses /use - as session.use.previous", () => {
  expect(parseCommand("/use -")).toEqual({ kind: "session.use.previous" });
});

test("parses /use <fragment> as session.use without matching", () => {
  expect(parseCommand("/use api")).toEqual({
    kind: "session.use",
    alias: "api",
  });
});

test("parses workspace creation flags", () => {
  expect(parseCommand("/workspace new backend --cwd /tmp/backend")).toEqual({
    kind: "workspace.new",
    name: "backend",
    cwd: "/tmp/backend",
  });
});

test("parses workspace creation aliases", () => {
  expect(parseCommand("/ws new backend -d /tmp/backend")).toEqual({
    kind: "workspace.new",
    name: "backend",
    cwd: "/tmp/backend",
  });
});

test("parses quoted workspace paths with spaces", () => {
  expect(parseCommand('/ws new backend -d "E:\\My Projects\\weacpx repo"')).toEqual({
    kind: "workspace.new",
    name: "backend",
    cwd: "E:\\My Projects\\weacpx repo",
  });
});

test("parses /ws new --raw flag in any position", () => {
  expect(parseCommand('/ws new "My Repo" -d /tmp/repo --raw')).toEqual({
    kind: "workspace.new",
    name: "My Repo",
    cwd: "/tmp/repo",
    raw: true,
  });
  expect(parseCommand("/ws new backend --raw -d /tmp/backend")).toEqual({
    kind: "workspace.new",
    name: "backend",
    cwd: "/tmp/backend",
    raw: true,
  });
});

test("parses /ws new without --raw and omits the raw field", () => {
  const parsed = parseCommand("/ws new backend -d /tmp/backend");
  expect(parsed).toEqual({
    kind: "workspace.new",
    name: "backend",
    cwd: "/tmp/backend",
  });
  expect("raw" in parsed).toBe(false);
});

test("parses workspace removal", () => {
  expect(parseCommand("/workspace rm backend")).toEqual({
    kind: "workspace.rm",
    name: "backend",
  });
});

test("treats bare session commands as the sessions list", () => {
  expect(parseCommand("/session")).toEqual({
    kind: "sessions",
  });
  expect(parseCommand("/ss")).toEqual({
    kind: "sessions",
  });
});

test("treats bare workspace commands as the workspaces list", () => {
  expect(parseCommand("/workspace")).toEqual({
    kind: "workspaces",
  });
  expect(parseCommand("/ws")).toEqual({
    kind: "workspaces",
  });
});

test("parses stop as cancel", () => {
  expect(parseCommand("/stop")).toEqual({
    kind: "cancel",
  });
});

test("parses /cancel without alias to the bare cancel shape", () => {
  expect(parseCommand("/cancel")).toEqual({
    kind: "cancel",
  });
});

test("parses /cancel <alias> with an alias", () => {
  expect(parseCommand("/cancel backend")).toEqual({
    kind: "cancel",
    alias: "backend",
  });
});

test("parses /stop <alias> as cancel with an alias", () => {
  expect(parseCommand("/stop backend")).toEqual({
    kind: "cancel",
    alias: "backend",
  });
});

test("parses session reset and clear aliases", () => {
  expect(parseCommand("/session reset")).toEqual({
    kind: "session.reset",
  });
  expect(parseCommand("/clear")).toEqual({
    kind: "session.reset",
  });
});

test("parses /session tail [N]", () => {
  expect(parseCommand("/session tail")).toEqual({
    kind: "session.tail",
  });
  expect(parseCommand("/ss tail 20")).toEqual({
    kind: "session.tail",
    lines: 20,
  });
});

test("rejects /session tail when N is invalid", () => {
  expect(parseCommand("/session tail 0")).toEqual({
    kind: "invalid",
    text: "/session tail 0",
    recognizedCommand: "/session",
  });
  expect(parseCommand("/session tail -1")).toEqual({
    kind: "invalid",
    text: "/session tail -1",
    recognizedCommand: "/session",
  });
  expect(parseCommand("/session tail foo")).toEqual({
    kind: "invalid",
    text: "/session tail foo",
    recognizedCommand: "/session",
  });
  expect(parseCommand("/session tail 10 extra")).toEqual({
    kind: "invalid",
    text: "/session tail 10 extra",
    recognizedCommand: "/session",
  });
});

test("parses /session archive <alias>", () => {
  expect(parseCommand("/session archive backend")).toEqual({ kind: "session.archive", alias: "backend" });
});

test("parses orchestration delegate commands", () => {
  expect(parseCommand("/delegate claude 审查当前方案")).toEqual({
    kind: "delegate.request",
    targetAgent: "claude",
    task: "审查当前方案",
  });
  expect(parseCommand("/dg claude 审查当前方案")).toEqual({
    kind: "delegate.request",
    targetAgent: "claude",
    task: "审查当前方案",
  });
  expect(parseCommand("/delegate claude --role reviewer 审查当前方案")).toEqual({
    kind: "delegate.request",
    targetAgent: "claude",
    role: "reviewer",
    task: "审查当前方案",
  });
  expect(parseCommand("/dg claude --role reviewer 审查当前方案")).toEqual({
    kind: "delegate.request",
    targetAgent: "claude",
    role: "reviewer",
    task: "审查当前方案",
  });
  expect(parseCommand("/dg claude --group group-review 审查当前方案")).toEqual({
    kind: "delegate.request",
    targetAgent: "claude",
    groupId: "group-review",
    task: "审查当前方案",
  });
  expect(parseCommand("/delegate claude --role reviewer --group group-review 审查当前方案")).toEqual({
    kind: "delegate.request",
    targetAgent: "claude",
    role: "reviewer",
    groupId: "group-review",
    task: "审查当前方案",
  });
});

test("free-text bodies keep quotes and internal spacing verbatim", () => {
  // Curly quotes (Chinese IME default) stay in the delegate task text.
  expect(parseCommand("/delegate claude 审查“报告”初稿")).toEqual({
    kind: "delegate.request",
    targetAgent: "claude",
    task: "审查“报告”初稿",
  });
  // Straight quotes stay; structured flag prefix still parses.
  expect(parseCommand('/dg claude --role reviewer remind me to say "hello"')).toEqual({
    kind: "delegate.request",
    targetAgent: "claude",
    role: "reviewer",
    task: 'remind me to say "hello"',
  });
  // A body that STARTS with a quoted word keeps its opening quote.
  expect(parseCommand('/delegate claude "hello world" now')).toEqual({
    kind: "delegate.request",
    targetAgent: "claude",
    task: '"hello world" now',
  });
  // Runs of internal spaces survive.
  expect(parseCommand("/delegate claude keep  two   spaces")).toEqual({
    kind: "delegate.request",
    targetAgent: "claude",
    task: "keep  two   spaces",
  });
  // Mixed straight + full-width quotes survive.
  expect(parseCommand('/delegate claude 检查＂版本＂和 "tag"')).toEqual({
    kind: "delegate.request",
    targetAgent: "claude",
    task: '检查＂版本＂和 "tag"',
  });
  // /group new title is verbatim.
  expect(parseCommand("/group new “并行 评审” v2")).toEqual({
    kind: "group.new",
    title: "“并行 评审” v2",
  });
  // /group add task tail is verbatim after the --role flag.
  expect(parseCommand('/group add g1 claude --role reviewer say "hi"  there')).toEqual({
    kind: "group.delegate",
    groupId: "g1",
    targetAgent: "claude",
    role: "reviewer",
    task: 'say "hi"  there',
  });
});

test("parses orchestration group commands", () => {
  expect(parseCommand("/groups")).toEqual({
    kind: "groups",
  });
  expect(parseCommand("/group new parallel-review")).toEqual({
    kind: "group.new",
    title: "parallel-review",
  });
  // The title is a free-text tail: it is stored verbatim, quotes included.
  expect(parseCommand('/group new "parallel review"')).toEqual({
    kind: "group.new",
    title: '"parallel review"',
  });
  expect(parseCommand("/group group-review")).toEqual({
    kind: "group.get",
    groupId: "group-review",
  });
  expect(parseCommand("/group cancel group-review")).toEqual({
    kind: "group.cancel",
    groupId: "group-review",
  });
});

test("parses orchestration task commands", () => {
  expect(parseCommand("/tasks")).toEqual({
    kind: "tasks",
  });
  expect(parseCommand("/task task-1")).toEqual({
    kind: "task.get",
    taskId: "task-1",
  });
  expect(parseCommand("/task approve task-1")).toEqual({
    kind: "task.approve",
    taskId: "task-1",
  });
  expect(parseCommand("/task reject task-1")).toEqual({
    kind: "task.reject",
    taskId: "task-1",
  });
  expect(parseCommand("/task cancel task-1")).toEqual({
    kind: "task.cancel",
    taskId: "task-1",
  });
});

test("parses agent template registration", () => {
  expect(parseCommand("/agent add claude")).toEqual({
    kind: "agent.add",
    template: "claude",
  });
});

test("parses agent removal", () => {
  expect(parseCommand("/agent rm claude")).toEqual({
    kind: "agent.rm",
    name: "claude",
  });
});

test("parses permission status commands", () => {
  expect(parseCommand("/pm")).toEqual({
    kind: "permission.status",
  });
  expect(parseCommand("/permission")).toEqual({
    kind: "permission.status",
  });
});

test("parses mode show and set commands", () => {
  expect(parseCommand("/mode")).toEqual({
    kind: "mode.show",
  });
  expect(parseCommand("/mode plan")).toEqual({
    kind: "mode.set",
    modeId: "plan",
  });
});

test("parses replymode show, set, and reset commands", () => {
  expect(parseCommand("/replymode")).toEqual({
    kind: "replymode.show",
  });
  expect(parseCommand("/replymode stream")).toEqual({
    kind: "replymode.set",
    replyMode: "stream",
  });
  expect(parseCommand("/replymode final")).toEqual({
    kind: "replymode.set",
    replyMode: "final",
  });
  expect(parseCommand("/replymode reset")).toEqual({
    kind: "replymode.reset",
  });
});

test("parses permission mode update commands", () => {
  expect(parseCommand("/pm set allow")).toEqual({
    kind: "permission.mode.set",
    mode: "approve-all",
  });
  expect(parseCommand("/pm set read")).toEqual({
    kind: "permission.mode.set",
    mode: "approve-reads",
  });
  expect(parseCommand("/pm set deny")).toEqual({
    kind: "permission.mode.set",
    mode: "deny-all",
  });
});

test("parses permission auto commands", () => {
  expect(parseCommand("/pm auto")).toEqual({
    kind: "permission.auto.status",
  });
  expect(parseCommand("/pm auto deny")).toEqual({
    kind: "permission.auto.set",
    policy: "deny",
  });
  expect(parseCommand("/pm auto fail")).toEqual({
    kind: "permission.auto.set",
    policy: "fail",
  });
});

test("parses config show and set commands", () => {
  expect(parseCommand("/config")).toEqual({
    kind: "config.show",
  });
  expect(parseCommand("/config set wechat.replyMode final")).toEqual({
    kind: "config.set",
    path: "wechat.replyMode",
    value: "final",
  });
  expect(parseCommand('/config set workspaces.backend.description "backend repo"')).toEqual({
    kind: "config.set",
    path: "workspaces.backend.description",
    value: "backend repo",
  });
});

test("treats plain text as a prompt", () => {
  expect(parseCommand("fix the timeout issue")).toEqual({
    kind: "prompt",
    text: "fix the timeout issue",
  });
});

test("parses the explicit session shortcut create command with the short workspace flag variant", () => {
  expect(parseCommand("/ss new claude -ws weacpx")).toEqual({
    kind: "session.shortcut.new",
    agent: "claude",
    workspace: "weacpx",
  });
});

test("parses /session new <agent> --ws <workspace> as shortcut create", () => {
  expect(parseCommand("/session new claude --ws weacpx")).toEqual({
    kind: "session.shortcut.new",
    agent: "claude",
    workspace: "weacpx",
  });
});

test("returns invalid for /session new missing --ws flag", () => {
  expect(parseCommand("/session new demo --agent codex")).toEqual({
    kind: "invalid",
    text: "/session new demo --agent codex",
    recognizedCommand: "/session",
  });
});

test("returns invalid for /session new with trailing junk", () => {
  expect(parseCommand("/session new demo --agent codex --ws backend extra")).toEqual({
    kind: "invalid",
    text: "/session new demo --agent codex --ws backend extra",
    recognizedCommand: "/session",
  });
});

test("returns invalid for /session attach missing --name", () => {
  expect(parseCommand("/session attach review --agent codex --ws backend")).toEqual({
    kind: "invalid",
    text: "/session attach review --agent codex --ws backend",
    recognizedCommand: "/session",
  });
});

test("returns invalid for /session attach with trailing junk", () => {
  expect(parseCommand("/session attach review --agent codex --ws backend --name x extra")).toEqual({
    kind: "invalid",
    text: "/session attach review --agent codex --ws backend --name x extra",
    recognizedCommand: "/session",
  });
});

test("returns invalid for /workspace new missing cwd value", () => {
  expect(parseCommand("/workspace new backend --cwd")).toEqual({
    kind: "invalid",
    text: "/workspace new backend --cwd",
    recognizedCommand: "/workspace",
  });
});

test("returns invalid for /workspace new with trailing junk", () => {
  expect(parseCommand("/workspace new backend --cwd /tmp/backend extra")).toEqual({
    kind: "invalid",
    text: "/workspace new backend --cwd /tmp/backend extra",
    recognizedCommand: "/workspace",
  });
});

test("returns prompt for unrecognized command prefix", () => {
  expect(parseCommand("/unknown_cmd foo bar")).toEqual({
    kind: "prompt",
    text: "/unknown_cmd foo bar",
  });
});

test("returns invalid for /session new with wrong flag", () => {
  expect(parseCommand("/session new demo --xyz value")).toEqual({
    kind: "invalid",
    text: "/session new demo --xyz value",
    recognizedCommand: "/session",
  });
});

test("returns invalid for /pm auto allow", () => {
  expect(parseCommand("/pm auto allow")).toEqual({
    kind: "invalid",
    text: "/pm auto allow",
    recognizedCommand: "/permission",
  });
});

test("returns invalid for malformed permission commands", () => {
  expect(parseCommand("/permission set foo")).toEqual({
    kind: "invalid",
    text: "/permission set foo",
    recognizedCommand: "/permission",
  });
  expect(parseCommand("/permission auto maybe")).toEqual({
    kind: "invalid",
    text: "/permission auto maybe",
    recognizedCommand: "/permission",
  });
  expect(parseCommand("/config set wechat.replyMode")).toEqual({
    kind: "invalid",
    text: "/config set wechat.replyMode",
    recognizedCommand: "/config",
  });
});

test("returns invalid for malformed orchestration commands", () => {
  expect(parseCommand("/delegate")).toEqual({
    kind: "invalid",
    text: "/delegate",
    recognizedCommand: "/delegate",
  });
  expect(parseCommand("/dg")).toEqual({
    kind: "invalid",
    text: "/dg",
    recognizedCommand: "/dg",
  });
  expect(parseCommand("/delegate claude --role reviewer")).toEqual({
    kind: "invalid",
    text: "/delegate claude --role reviewer",
    recognizedCommand: "/delegate",
  });
  expect(parseCommand("/dg claude --role reviewer")).toEqual({
    kind: "invalid",
    text: "/dg claude --role reviewer",
    recognizedCommand: "/dg",
  });
  expect(parseCommand("/group")).toEqual({
    kind: "invalid",
    text: "/group",
    recognizedCommand: "/group",
  });
  expect(parseCommand("/group new")).toEqual({
    kind: "invalid",
    text: "/group new",
    recognizedCommand: "/group",
  });
  expect(parseCommand("/group cancel")).toEqual({
    kind: "invalid",
    text: "/group cancel",
    recognizedCommand: "/group",
  });
  expect(parseCommand("/group cancel too many args")).toEqual({
    kind: "invalid",
    text: "/group cancel too many args",
    recognizedCommand: "/group",
  });
  expect(parseCommand("/groups extra")).toEqual({
    kind: "invalid",
    text: "/groups extra",
    recognizedCommand: "/groups",
  });
  expect(parseCommand("/task")).toEqual({
    kind: "invalid",
    text: "/task",
    recognizedCommand: "/task",
  });
  expect(parseCommand("/tasks extra")).toEqual({
    kind: "invalid",
    text: "/tasks extra",
    recognizedCommand: "/tasks",
  });
  expect(parseCommand("/task cancel")).toEqual({
    kind: "invalid",
    text: "/task cancel",
    recognizedCommand: "/task",
  });
  expect(parseCommand("/task task-1 extra")).toEqual({
    kind: "invalid",
    text: "/task task-1 extra",
    recognizedCommand: "/task",
  });
});

test("parses /group add <groupId> <agent> <task>", () => {
  expect(parseCommand("/group add group-review claude 审查当前方案")).toEqual({
    kind: "group.delegate",
    groupId: "group-review",
    targetAgent: "claude",
    task: "审查当前方案",
  });
});

test("parses /group add with --role before the task", () => {
  expect(parseCommand("/group add group-review claude --role reviewer 审查当前方案")).toEqual({
    kind: "group.delegate",
    groupId: "group-review",
    targetAgent: "claude",
    role: "reviewer",
    task: "审查当前方案",
  });
});

test("rejects /group add with no task body", () => {
  expect(parseCommand("/group add group-review claude")).toEqual({
    kind: "invalid",
    text: "/group add group-review claude",
    recognizedCommand: "/group",
  });
});

test("rejects /group add with missing agent", () => {
  expect(parseCommand("/group add group-review")).toEqual({
    kind: "invalid",
    text: "/group add group-review",
    recognizedCommand: "/group",
  });
});

test("parses /tasks with --status and --stuck flags", () => {
  expect(parseCommand("/tasks --status running")).toEqual({
    kind: "tasks",
    filter: { status: "running" },
  });
  expect(parseCommand("/tasks --stuck")).toEqual({
    kind: "tasks",
    filter: { stuck: true },
  });
  expect(parseCommand("/tasks --status failed --sort createdAt --order asc")).toEqual({
    kind: "tasks",
    filter: { status: "failed", sort: "createdAt", order: "asc" },
  });
});

test("parses /groups with --status and --stuck flags", () => {
  expect(parseCommand("/groups --status pending")).toEqual({
    kind: "groups",
    filter: { status: "pending" },
  });
  expect(parseCommand("/groups --stuck")).toEqual({
    kind: "groups",
    filter: { stuck: true },
  });
});

test("parseCommand rejects unknown --status for /tasks", () => {
  expect(parseCommand("/tasks --status runing")).toMatchObject({ kind: "invalid" });
});

test("parseCommand rejects unknown --status for /groups", () => {
  expect(parseCommand("/groups --status active")).toMatchObject({ kind: "invalid" });
});

test("parseCommand accepts needs_confirmation for /tasks", () => {
  expect(parseCommand("/tasks --status needs_confirmation")).toEqual({
    kind: "tasks",
    filter: { status: "needs_confirmation" },
  });
});

test("parses later commands", () => {
  expect(parseCommand("/later")).toEqual({ kind: "later.help" });
  expect(parseCommand("/lt")).toEqual({ kind: "later.help" });
  expect(parseCommand("/lt list")).toEqual({ kind: "later.list" });
  expect(parseCommand("/later cancel #K8F2")).toEqual({ kind: "later.cancel", id: "#K8F2" });
  expect(parseCommand("/lt in 2h 检查 CI")).toEqual({
    kind: "later.create",
    tokens: ["in", "2h", "检查", "CI"],
    tails: ["in 2h 检查 CI", "2h 检查 CI", "检查 CI", "CI"],
  });
});

test("later.create tails keep quotes and internal spacing verbatim", () => {
  // Curly quotes (Chinese IME default) survive in the tail even though the
  // tokenized values strip them.
  expect(parseCommand("/later in 2h 提醒我看“报告”")).toEqual({
    kind: "later.create",
    tokens: ["in", "2h", "提醒我看报告"],
    tails: ["in 2h 提醒我看“报告”", "2h 提醒我看“报告”", "提醒我看“报告”"],
  });
  // Straight quotes and a multi-space run survive; a tail that starts with a
  // quoted word keeps its opening quote.
  expect(parseCommand('/later in 2h say "hello"  twice')).toEqual({
    kind: "later.create",
    tokens: ["in", "2h", "say", "hello", "twice"],
    tails: [
      'in 2h say "hello"  twice',
      '2h say "hello"  twice',
      'say "hello"  twice',
      '"hello"  twice',
      "twice",
    ],
  });
  // Full-width quotes survive too.
  expect(parseCommand("/lt in 2h 检查＂版本＂号")).toEqual({
    kind: "later.create",
    tokens: ["in", "2h", "检查版本号"],
    tails: ["in 2h 检查＂版本＂号", "2h 检查＂版本＂号", "检查＂版本＂号"],
  });
});

test("command names are case-insensitive", () => {
  expect(parseCommand("/Status")).toEqual({ kind: "status" });
  expect(parseCommand("/CLEAR")).toEqual({ kind: "session.reset" });
  expect(parseCommand("/SS")).toEqual({ kind: "sessions" });
  expect(parseCommand("/Sessions")).toEqual({ kind: "sessions" });
});

test("arguments keep their case when the command name is mixed-case", () => {
  expect(parseCommand("/USE MyAlias")).toEqual({ kind: "session.use", alias: "MyAlias" });
  expect(parseCommand("/Session new Api-Fix --agent codex --ws Backend")).toEqual({
    kind: "session.new",
    alias: "Api-Fix",
    agent: "codex",
    workspace: "Backend",
  });
});

test("tokenizes curly double quotes from mobile keyboards", () => {
  expect(parseCommand("/session new api-fix --agent codex --ws “my dir”")).toEqual({
    kind: "session.new",
    alias: "api-fix",
    agent: "codex",
    workspace: "my dir",
  });
});

test("tokenizes curly single and full-width quotes", () => {
  expect(parseCommand("/ws new backend -d ‘E:\\My Projects\\repo’")).toEqual({
    kind: "workspace.new",
    name: "backend",
    cwd: "E:\\My Projects\\repo",
  });
  expect(parseCommand("/ws new backend -d ＂E:\\My Projects\\repo＂")).toEqual({
    kind: "workspace.new",
    name: "backend",
    cwd: "E:\\My Projects\\repo",
  });
});

test("a straight quote does not close a curly quote and vice versa", () => {
  // straight " inside curly quotes stays literal
  expect(parseCommand("/ws new backend -d “ab\"cd ef”")).toEqual({
    kind: "workspace.new",
    name: "backend",
    cwd: 'ab"cd ef',
  });
  // curly apostrophe inside straight quotes stays literal
  expect(parseCommand('/ws new backend -d "don’t stop"')).toEqual({
    kind: "workspace.new",
    name: "backend",
    cwd: "don’t stop",
  });
});

test("a stray closing curly quote is treated as a literal character", () => {
  expect(parseCommand("/use ali’as")).toEqual({ kind: "session.use", alias: "ali’as" });
});
