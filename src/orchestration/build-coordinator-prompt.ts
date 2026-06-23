import { t } from "../i18n";
import { truncateText } from "../util/text.js";
import type { OrchestrationGroupRecord, OrchestrationTaskRecord } from "./orchestration-types";
import { renderDelegateGroupResultBlocks } from "./render-delegate-group-result";
import { renderDelegateQuestionPackage } from "./render-delegate-question-package";
import { renderDelegateResultBlocks } from "./render-delegate-result";

interface ActiveHumanQuestionPackageView {
  packageId: string;
  promptText: string;
  awaitingReplyMessageId?: string;
  deliveredChatKey?: string;
  deliveryAccountId?: string;
  routeReplyContextToken?: string;
  deliveredAt?: string;
  openTaskIds: string[];
  messageTaskQuestions?: Array<{
    taskId: string;
    questionId: string;
  }>;
  openTaskQuestions?: Array<{
    taskId: string;
    questionId: string;
    question: string;
    whyBlocked: string;
    whatIsNeeded: string;
  }>;
  queuedCount: number;
}

function renderTaskQuestionScope(
  title: string,
  taskQuestions: Array<{
    taskId: string;
    questionId: string;
    question?: string;
    whyBlocked?: string;
    whatIsNeeded?: string;
  }>,
): string {
  const lines = [title];
  if (taskQuestions.length === 0) {
    lines.push("- none");
    return lines.join("\n");
  }

  for (const task of taskQuestions) {
    lines.push(`- task_id: ${task.taskId}`);
    lines.push(`  question_id: ${task.questionId}`);
    if (task.question) {
      lines.push(`  question: ${task.question}`);
    }
    if (task.whyBlocked) {
      lines.push(`  why_blocked: ${task.whyBlocked}`);
    }
    if (task.whatIsNeeded) {
      lines.push(`  what_is_needed: ${task.whatIsNeeded}`);
    }
  }
  return lines.join("\n");
}

export function shouldBindHumanReply(input: {
  chatKey?: string;
  accountId?: string;
  replyContextToken?: string;
  activePackage?: {
    awaitingReplyMessageId?: string;
    deliveredChatKey?: string;
    deliveryAccountId?: string;
    routeReplyContextToken?: string;
    messageTaskQuestions?: Array<{ taskId: string; questionId: string }>;
  } | null;
}): boolean {
  return (
    Boolean(input.chatKey) &&
    Boolean(input.activePackage?.awaitingReplyMessageId) &&
    input.activePackage?.deliveredChatKey === input.chatKey &&
    (input.activePackage?.deliveryAccountId === undefined ||
      input.activePackage.deliveryAccountId === input.accountId) &&
    (input.activePackage?.routeReplyContextToken === undefined ||
      input.activePackage.routeReplyContextToken === input.replyContextToken) &&
    (input.activePackage?.messageTaskQuestions?.length ?? 0) > 0
  );
}

export async function buildCoordinatorPrompt(input: {
  orchestration: {
    listPendingCoordinatorGroups?: (coordinatorSession: string) => Promise<OrchestrationGroupRecord[]>;
    listPendingCoordinatorResults: (coordinatorSession: string) => Promise<OrchestrationTaskRecord[]>;
    listPendingCoordinatorBlockers?: (coordinatorSession: string) => Promise<OrchestrationTaskRecord[]>;
    listContestedCoordinatorResults?: (coordinatorSession: string) => Promise<OrchestrationTaskRecord[]>;
    getActiveHumanQuestionPackage?: (
      coordinatorSession: string,
    ) => Promise<ActiveHumanQuestionPackageView | null>;
  };
  coordinatorSession: string;
  chatKey?: string;
  accountId?: string;
  replyContextToken?: string;
  userText?: string;
  maxPromptLength?: number;
}): Promise<{
  promptText: string;
  taskIds: string[];
  groupIds: string[];
  claimHumanReply?: {
    coordinatorSession: string;
    chatKey: string;
    packageId: string;
    messageId: string;
    accountId?: string;
    replyContextToken?: string;
  };
}> {
  const pendingGroups = (await input.orchestration.listPendingCoordinatorGroups?.(input.coordinatorSession)) ?? [];
  const pendingResults = await input.orchestration.listPendingCoordinatorResults(input.coordinatorSession);
  const blockedTasks = (await input.orchestration.listPendingCoordinatorBlockers?.(input.coordinatorSession)) ?? [];
  const contestedReviews =
    (await input.orchestration.listContestedCoordinatorResults?.(input.coordinatorSession)) ?? [];
  const activePackage = await input.orchestration.getActiveHumanQuestionPackage?.(input.coordinatorSession);
  const messageSnapshotQuestions = activePackage?.messageTaskQuestions ?? [];
  const messageSnapshotKeys = new Set(
    messageSnapshotQuestions.map((task) => `${task.taskId}:${task.questionId}`),
  );
  const reopenedOutsideSnapshot =
    activePackage?.openTaskQuestions?.filter((task) => !messageSnapshotKeys.has(`${task.taskId}:${task.questionId}`)) ?? [];
  const shouldBind = shouldBindHumanReply({
    chatKey: input.chatKey,
    accountId: input.accountId,
    replyContextToken: input.replyContextToken,
    activePackage: activePackage
      ? {
          awaitingReplyMessageId: activePackage.awaitingReplyMessageId,
          deliveredChatKey: activePackage.deliveredChatKey,
          deliveryAccountId: activePackage.deliveryAccountId,
          routeReplyContextToken: activePackage.routeReplyContextToken,
          messageTaskQuestions: activePackage.messageTaskQuestions,
        }
      : null,
  });
  const packageOpenTaskIds = activePackage ? new Set(activePackage.openTaskIds) : null;
  const blockerPackageTasks = shouldBind && packageOpenTaskIds
    ? blockedTasks.filter((task) => packageOpenTaskIds.has(task.taskId))
    : blockedTasks;
  const blockerPackageContestedReviews = shouldBind && packageOpenTaskIds
    ? contestedReviews.filter((review) => packageOpenTaskIds.has(review.taskId))
    : contestedReviews;

  const tasksByGroup = new Map<string, OrchestrationTaskRecord[]>();
  for (const task of pendingResults) {
    if (!task.groupId) {
      continue;
    }
    const groupTasks = tasksByGroup.get(task.groupId) ?? [];
    groupTasks.push(task);
    tasksByGroup.set(task.groupId, groupTasks);
  }

  const readyGroups = pendingGroups
    .map((group) => ({ group, tasks: tasksByGroup.get(group.groupId) ?? [] }))
    .filter(({ tasks }) => tasks.length > 0);
  const groupedTaskIds = new Set(readyGroups.flatMap(({ tasks }) => tasks.map((task) => task.taskId)));
  const standaloneResults = pendingResults.filter((task) => !groupedTaskIds.has(task.taskId));

  const sections: string[] = [];
  if (readyGroups.length > 0 || standaloneResults.length > 0) {
    const blocks: string[] = [];
    if (readyGroups.length > 0) {
      blocks.push(renderDelegateGroupResultBlocks(readyGroups));
    }
    if (standaloneResults.length > 0) {
      blocks.push(renderDelegateResultBlocks(standaloneResults));
    }
    sections.push(
      [t().coordinatorPrompt.pendingResultsHeader, blocks.join("\n\n")]
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  if (blockerPackageTasks.length > 0 || blockerPackageContestedReviews.length > 0) {
    sections.push(
      renderDelegateQuestionPackage({
        coordinatorSession: input.coordinatorSession,
        blockedTasks: blockerPackageTasks.flatMap((task) => {
          if (!task.openQuestion) {
            return [];
          }
          return [
            {
              taskId: task.taskId,
              workerSession: task.workerSession,
              targetAgent: task.targetAgent,
              question: task.openQuestion.question,
              whyBlocked: task.openQuestion.whyBlocked,
              whatIsNeeded: task.openQuestion.whatIsNeeded,
            },
          ];
        }),
        contestedReviews: blockerPackageContestedReviews.flatMap((task) => {
          if (!task.reviewPending) {
            return [];
          }
          return [
            {
              taskId: task.taskId,
              reviewId: task.reviewPending.reviewId,
              resultId: task.reviewPending.resultId,
              resultText: task.reviewPending.resultText,
            },
          ];
        }),
      }),
    );
  }

  if (shouldBind && activePackage) {
    sections.push(
      [
        t().coordinatorPrompt.humanReplyBindingHeader,
        activePackage.promptText,
        renderTaskQuestionScope("message_snapshot_tasks:", messageSnapshotQuestions),
        ...(reopenedOutsideSnapshot.length > 0
          ? [
              renderTaskQuestionScope(
                t().coordinatorPrompt.reopenedOutsideSnapshotLabel,
                reopenedOutsideSnapshot,
              ),
            ]
          : []),
      ].join("\n"),
    );
  } else if (activePackage?.awaitingReplyMessageId && messageSnapshotQuestions.length > 0) {
    sections.push(
      [
        t().coordinatorPrompt.activePackageAwaitingReply,
        activePackage.promptText,
        ...(reopenedOutsideSnapshot.length > 0
          ? [renderTaskQuestionScope("reopened_tasks_outside_snapshot:", reopenedOutsideSnapshot)]
          : []),
      ].join("\n"),
    );
  } else if (activePackage && !activePackage.deliveredAt) {
    sections.push(
      [
        t().coordinatorPrompt.packageNotDelivered,
        activePackage.promptText,
        ...(reopenedOutsideSnapshot.length > 0
          ? [renderTaskQuestionScope("reopened_tasks_outside_snapshot:", reopenedOutsideSnapshot)]
          : []),
      ].join("\n"),
    );
  } else if (activePackage && (activePackage.openTaskQuestions?.length ?? 0) > 0) {
    sections.push(
      [
        t().coordinatorPrompt.activePackageNotClosed,
        renderTaskQuestionScope("unresolved_tasks:", activePackage.openTaskQuestions ?? []),
        [t().coordinatorPrompt.recentHumanPackageLabel, activePackage.promptText].join("\n"),
      ].join("\n\n"),
    );
  }

  if (input.userText) {
    // Only label the user's message when orchestration context precedes it (pending
    // results, blockers, an active human-question package), so the agent can tell the
    // injected context apart from the actual message. In an ordinary session with no
    // such context — including a plain native session — send the text verbatim rather
    // than prefixing every single message with the label.
    const hasOrchestrationContext = sections.length > 0;
    sections.push(
      hasOrchestrationContext
        ? [t().coordinatorPrompt.userMessageLabel, input.userText].join("\n")
        : input.userText,
    );
  }

  const claimHumanReply =
    shouldBind && input.chatKey && activePackage?.awaitingReplyMessageId
      ? {
          coordinatorSession: input.coordinatorSession,
          chatKey: input.chatKey,
          packageId: activePackage.packageId,
          messageId: activePackage.awaitingReplyMessageId,
          ...(input.accountId ? { accountId: input.accountId } : {}),
          ...(input.replyContextToken ? { replyContextToken: input.replyContextToken } : {}),
        }
      : undefined;

  let promptText = sections.length > 0 ? sections.join("\n\n") : (input.userText ?? "");

  if (input.maxPromptLength && promptText.length > input.maxPromptLength) {
    promptText = truncateText(promptText, input.maxPromptLength, "...");
  }

  return {
    promptText,
    taskIds: [...groupedTaskIds, ...standaloneResults.map((task) => task.taskId)],
    groupIds: readyGroups.map(({ group }) => group.groupId),
    ...(claimHumanReply ? { claimHumanReply } : {}),
  };
}
