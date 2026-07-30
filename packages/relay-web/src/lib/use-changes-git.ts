import { computed, ref, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import { useFilesStore } from "../stores/files";
import { useGitStore } from "../stores/git";
import { useInstancesStore } from "../stores/instances";
import { useChatStore } from "../stores/chat";
import { groupChanges } from "./change-groups";
import { confirm } from "./use-confirm";
import { slugify, uniqueName } from "./session-form";
import { useWorktreeSession } from "./use-worktree-session";

/** Owns the Changes rail's mutable Git workflows. FilesPanel supplies only the active
 * instance and renders the returned view model alongside its file-navigation state. */
export function useChangesGit(instanceId: Ref<string | null>) {
  const { t } = useI18n();
  const files = useFilesStore();
  const git = useGitStore();
  const instances = useInstancesStore();
  const chat = useChatStore();
  const worktreeSession = useWorktreeSession();

  const gitCtx = computed(() => {
    const d = files.diff;
    return d ? { branch: d.branch, detached: d.detached === true, worktree: d.worktree } : null;
  });
  const activeSession = computed(() => {
    const inst = instanceId.value ? instances.byId(instanceId.value) : undefined;
    return inst?.sessions.find((session) => session.alias === chat.sessionAlias);
  });
  const gitBusy = computed(() => git.operation !== null);
  const stagedPaths = computed(() => [...new Set((files.diff?.files ?? [])
    .filter((file) => file.status[0] !== " " && file.status[0] !== "?")
    .map((file) => file.path))]);
  const stageablePaths = computed(() => [...new Set((files.diff?.files ?? [])
    .filter((file) => file.status[1] !== " " || file.status === "??")
    .map((file) => file.path))]);
  const gitMessage = computed(() => {
    if (git.error) {
      const known: Record<string, string> = {
        "dirty-worktree": t("files.git.errors.dirtyWorktree"),
        "no-upstream": t("files.git.errors.noUpstream"),
        "files-write-disabled": t("files.git.errors.writeDisabled"),
        "invalid-branch-name": t("files.git.errors.invalidBranch"),
        "invalid-start-point": t("files.git.errors.invalidStartPoint"),
        "workspace-name-exists": t("files.git.errors.workspaceExists"),
        "unknown-remote": t("files.git.errors.unknownRemote"),
        "detached-head": t("files.git.errors.detachedHead"),
        "git-operation-in-progress": t("files.git.errors.inProgress"),
      };
      return { ok: false, text: known[git.error] ?? git.error };
    }
    if (git.operation) return { ok: true, text: t(`files.git.running.${git.operation.kind}`) };
    if (git.lastResult?.ok) return { ok: true, text: t(`files.git.done.${git.lastResult.kind}`) };
    return null;
  });

  const commitMessage = ref("");
  const showBranchCreate = ref(false);
  const branchName = ref("");
  const branchStart = ref("");
  const showWorktrees = ref(false);
  const showWorktreeCreate = ref(false);
  const worktreeBranch = ref("");
  const worktreeStart = ref("");
  const worktreeWorkspace = ref("");
  const worktreeCreateBranch = ref(true);

  async function refreshGit(): Promise<void> {
    if (!instanceId.value || !files.workspace) return;
    await Promise.all([git.load(instanceId.value, files.workspace), files.loadDiff()]);
  }

  async function runGit(action: () => Promise<unknown>): Promise<boolean> {
    const context = { instanceId: instanceId.value, workspace: files.workspace };
    try {
      await action();
      if (instanceId.value === context.instanceId && files.workspace === context.workspace) {
        await files.loadDiff();
      }
      return true;
    } catch {
      return false;
    }
  }

  async function stage(paths: string[]): Promise<void> {
    if (!instanceId.value || !files.workspace || !paths.length) return;
    await runGit(() => git.stage(instanceId.value!, files.workspace!, paths));
  }

  async function unstage(paths: string[]): Promise<void> {
    if (!instanceId.value || !files.workspace || !paths.length) return;
    await runGit(() => git.unstage(instanceId.value!, files.workspace!, paths));
  }

  async function untrack(path: string): Promise<void> {
    if (!instanceId.value || !files.workspace || !path) return;
    const ok = await confirm({
      title: t("files.git.untrackTitle"),
      message: t("files.git.untrackBody", { path }),
      confirmLabel: t("files.git.untrackConfirm"),
      cancelLabel: t("files.cancel"),
      tone: "danger",
    });
    if (!ok) return;
    await runGit(() => git.untrack(instanceId.value!, files.workspace!, [path]));
  }

  async function discard(entry: { path: string; status: string }): Promise<void> {
    if (!instanceId.value || !files.workspace || !entry.path) return;
    const untracked = entry.status === "??";
    const ok = await confirm({
      title: t(untracked ? "files.git.discardUntrackedTitle" : "files.git.discardTitle"),
      message: t(untracked ? "files.git.discardUntrackedBody" : "files.git.discardBody", { path: entry.path }),
      confirmLabel: t(untracked ? "files.git.discardUntrackedConfirm" : "files.git.discardConfirm"),
      cancelLabel: t("files.cancel"),
      tone: "danger",
    });
    if (!ok) return;
    await runGit(() => git.discard(instanceId.value!, files.workspace!, [entry.path]));
  }

  async function commitStaged(): Promise<void> {
    const message = commitMessage.value.trim();
    if (!instanceId.value || !files.workspace || !message || !stagedPaths.value.length) return;
    if (await runGit(() => git.commit(instanceId.value!, files.workspace!, message))) commitMessage.value = "";
  }

  async function switchBranch(event: Event): Promise<void> {
    const select = event.target as HTMLSelectElement;
    const branch = select.value;
    if (!instanceId.value || !files.workspace || !branch || branch === git.status?.branch) return;
    if (!await runGit(() => git.checkout(instanceId.value!, files.workspace!, { branch }))) {
      select.value = git.status?.branch ?? "";
    }
  }

  async function createBranch(): Promise<void> {
    const branch = branchName.value.trim();
    if (!instanceId.value || !files.workspace || !branch) return;
    const ok = await runGit(() => git.checkout(instanceId.value!, files.workspace!, {
      branch,
      create: true,
      ...(branchStart.value.trim() ? { startPoint: branchStart.value.trim() } : {}),
    }));
    if (ok) {
      branchName.value = "";
      branchStart.value = "";
      showBranchCreate.value = false;
    }
  }

  async function fetchRemote(): Promise<void> {
    if (instanceId.value && files.workspace) await runGit(() => git.fetch(instanceId.value!, files.workspace!));
  }
  async function pullRemote(): Promise<void> {
    if (instanceId.value && files.workspace) await runGit(() => git.pull(instanceId.value!, files.workspace!));
  }
  async function pushRemote(): Promise<void> {
    if (!instanceId.value || !files.workspace || !git.status || git.status.detached) return;
    let setUpstream = false;
    if (!git.status.upstream) {
      setUpstream = await confirm({
        title: t("files.git.pushFirstTitle"),
        message: t("files.git.pushFirstBody", { branch: git.status.branch ?? "HEAD" }),
        confirmLabel: t("files.git.pushAndTrack"),
        cancelLabel: t("files.cancel"),
      });
      if (!setUpstream) return;
    }
    await runGit(() => git.push(instanceId.value!, files.workspace!, setUpstream ? { setUpstream: true, remote: "origin" } : {}));
  }

  function beginWorktreeCreate(): void {
    worktreeBranch.value = "";
    worktreeStart.value = git.status?.branch ?? "main";
    const base = slugify(`${files.workspace ?? "workspace"}-worktree`) || "worktree";
    const existing = instances.byId(instanceId.value ?? "")?.workspaces.map((item) => item.name) ?? [];
    worktreeWorkspace.value = uniqueName(base, existing);
    worktreeCreateBranch.value = true;
    showWorktreeCreate.value = true;
  }

  async function createWorktree(): Promise<void> {
    const id = instanceId.value;
    const workspace = files.workspace;
    const branch = worktreeBranch.value.trim();
    const workspaceName = worktreeWorkspace.value.trim();
    const agent = activeSession.value?.agent;
    const sourceSessionAlias = chat.sessionAlias;
    if (!id || !workspace || !branch || !workspaceName || !agent || !sourceSessionAlias) return;
    try {
      const created = await git.createWorktree(id, workspace, {
        workspaceName,
        branch,
        createBranch: worktreeCreateBranch.value,
        ...(worktreeCreateBranch.value && worktreeStart.value.trim() ? { startPoint: worktreeStart.value.trim() } : {}),
      });
      await worktreeSession.open(id, agent, created.workspace.name, sourceSessionAlias);
      showWorktreeCreate.value = false;
    } catch {
      // The Git store owns the actionable inline error and operation lifecycle.
    }
  }

  const changesSummary = computed(() => {
    const d = files.diff;
    if (!d) return null;
    let add = 0;
    let del = 0;
    for (const line of d.diff ? d.diff.split("\n") : []) {
      if (line.startsWith("+") && !line.startsWith("+++")) add++;
      else if (line.startsWith("-") && !line.startsWith("---")) del++;
    }
    return { fileCount: d.files.length, add, del };
  });
  const changeSections = computed(() => {
    const grouped = groupChanges(files.diff?.files ?? []);
    return [
      { key: "staged", items: grouped.staged },
      { key: "changes", items: grouped.changes },
      { key: "untracked", items: grouped.untracked },
    ].filter((section) => section.items.length);
  });

  const collapseKey = "xacpx.changes.collapsed";
  const collapsed = ref<Record<string, boolean>>(loadCollapsed());
  function loadCollapsed(): Record<string, boolean> {
    try { return JSON.parse(localStorage.getItem(collapseKey) ?? "{}") as Record<string, boolean>; }
    catch { return {}; }
  }
  function toggleGroup(key: string): void {
    collapsed.value = { ...collapsed.value, [key]: !collapsed.value[key] };
    try { localStorage.setItem(collapseKey, JSON.stringify(collapsed.value)); }
    catch { /* private mode / quota — collapse just won't persist */ }
  }

  function statusBadge(code: string): { label: string; cls: string } {
    const value = code.trim();
    if (value.includes("?")) return { label: "U", cls: "text-warn" };
    if (value.includes("A")) return { label: "A", cls: "text-run" };
    if (value.includes("D")) return { label: "D", cls: "text-danger" };
    if (value.includes("R")) return { label: "R", cls: "text-accent" };
    if (value.includes("M")) return { label: "M", cls: "text-info" };
    return { label: value[0] ?? "•", cls: "text-fg-muted" };
  }

  return {
    git, gitCtx, activeSession, gitBusy, stagedPaths, stageablePaths, gitMessage,
    commitMessage, showBranchCreate, branchName, branchStart, showWorktrees,
    showWorktreeCreate, worktreeBranch, worktreeStart, worktreeWorkspace,
    worktreeCreateBranch, changesSummary, changeSections, collapsed,
    refreshGit, stage, unstage, untrack, discard, commitStaged, switchBranch, createBranch,
    fetchRemote, pullRemote, pushRemote, beginWorktreeCreate, createWorktree,
    toggleGroup, statusBadge,
  };
}
