import type { ResolvedSession } from "../../transport/types";
import type { RouterResponse, SessionRecoveryOps } from "../router-types";
import { isPartialPromptOutputError, summarizeTransportError } from "../transport-diagnostics";
import { AutoInstallFailedError } from "../../recovery/errors";
import { quoteWorkspaceNameIfNeeded } from "../workspace-name";
import { t } from "../../i18n";
import {
  DEFAULT_ADAPTER_REGISTRY,
  isNpmAdapterRegistryNotFoundOutput,
} from "../../adapters/adapter-registry";
import { managedAdapterRegistryFromCommand } from "../../adapters/adapter-catalog";
import { AcpxQueueOverflowError } from "../../transport/acpx-queue-overflow";

export function renderTransportError(session: ResolvedSession, error: unknown): RouterResponse {
  if (error instanceof AcpxQueueOverflowError) {
    const confirmed = error.cleanup?.ownerTerminationSucceeded === true;
    if (confirmed) {
      return {
        text: [t().recovery.queueOverflowWarning, t().recovery.queueOverflowHint]
          .filter((line) => line.length > 0)
          .join("\n"),
      };
    }
    return {
      text: [t().recovery.queueOverflowWarning, t().recovery.queueOverflowUnconfirmedHint]
        .filter((line) => line.length > 0)
        .join("\n"),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const registryError = renderAdapterRegistryError(session, message);
  if (registryError) return registryError;

  if (message.includes("No acpx session found")) {
    if (session.transient) {
      // Transient scheduled (temp-mode) session: it is created on demand at
      // trigger time and never persisted, so advising /session new/attach by
      // its `later-<id>` alias would be nonsensical.
      return {
        text: [
          t().recovery.transientSessionFailed,
          t().recovery.transientSessionHint,
        ].join("\n"),
      };
    }
    const quotedWs = quoteWorkspaceNameIfNeeded(session.workspace);
    return {
      text: [
        t().recovery.sessionUnavailable(session.alias),
        t().recovery.sessionUnavailableRenewHint(session.alias, session.agent, quotedWs),
        t().recovery.sessionUnavailableAttachHint(session.alias, session.agent, quotedWs),
      ].join("\n"),
    };
  }

  if (!isPartialPromptOutputError(message)) {
    throw error;
  }

  return {
    text: [
      t().recovery.sessionInterrupted(session.alias),
      t().recovery.sessionInterruptedHint,
      t().recovery.sessionInterruptedError(summarizeTransportError(message)),
    ].join("\n"),
  };
}

export function renderSessionCreationError(session: ResolvedSession, error: unknown): RouterResponse {
  if (error instanceof AutoInstallFailedError) {
    const { original, steps, logPath } = error;
    const r = t().recovery;
    const allVerifyFailed = steps.length > 0 && steps.every((s) => s.reason === "verify-failed");
    const headline = allVerifyFailed ? r.autoInstallHeadlineFixed : r.autoInstallHeadlineFailed;
    const stepLines = steps
      .map((s) => {
        const perStepPath = s.path ?? (s.scope === "precise" ? original.parentPackagePath : null);
        const label = s.scope === "precise"
          ? r.autoInstallScopePrecise(s.manager, perStepPath ?? undefined)
          : r.autoInstallScopeGlobal;
        if (s.reason === "verify-failed") {
          return r.autoInstallStepVerifyFailed(label);
        }
        return r.autoInstallStepError(label, s.stderrTail);
      })
      .join("\n\n");
    return {
      text: [
        headline,
        ``,
        r.autoInstallOriginalError,
        original.rawMessage,
        ``,
        stepLines,
        ``,
        r.autoInstallManual(original.package),
        r.autoInstallLog(logPath),
      ].join("\n"),
    };
  }

  const message = error instanceof Error ? error.message : String(error);

  const registryError = renderAdapterRegistryError(session, message);
  if (registryError) return {
    text: [
      t().recovery.sessionCreationFailed,
      registryError.text,
    ].join("\n"),
  };

  if (message.includes("timed out") && message.includes("sessions new")) {
    return renderSessionCreationFailure(session, message);
  }

  throw error;
}

function renderAdapterRegistryError(session: ResolvedSession, message: string): RouterResponse | null {
  const registry = managedAdapterRegistryFromCommand(session.agentCommand);
  if (!registry || !isNpmAdapterRegistryNotFoundOutput(message)) return null;
  return {
    text: t().recovery.adapterRegistryE404(registry, DEFAULT_ADAPTER_REGISTRY),
  };
}

export function renderSessionCreationVerificationError(session: ResolvedSession): RouterResponse {
  return renderSessionCreationFailure(session, t().recovery.sessionCreationVerificationDetail);
}

function renderSessionCreationFailure(session: ResolvedSession, detail: string): RouterResponse {
  const r = t().recovery;
  return {
    text: [
      r.sessionCreationFailed,
      r.sessionCreationError(summarizeTransportError(detail)),
      r.sessionCreationAttachHint(session.alias, session.agent, quoteWorkspaceNameIfNeeded(session.workspace)),
    ].join("\n"),
  };
}

export async function tryRecoverMissingSession(
  ops: SessionRecoveryOps,
  session: ResolvedSession,
  error: unknown,
): Promise<ResolvedSession | null> {
  if (error instanceof AcpxQueueOverflowError) return null;
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("No acpx session found")) {
    return null;
  }

  // Transient scheduled sessions are not persisted; the agent-command recovery
  // path mutates persisted state by alias and would throw on the missing alias.
  if (session.transient) {
    return null;
  }

  const transportAgentCommand = await ops.resolveSessionAgentCommand(session);
  if (!transportAgentCommand || transportAgentCommand === session.agentCommand) {
    return null;
  }

  await ops.setSessionTransportAgentCommand(session.alias, transportAgentCommand);
  return await ops.getSession(session.alias);
}
