/**
 * Refusal reasons for workspace registry removal, shared by the daemon wiring
 * (`src/main.ts`) and the Bot auto-workspace rollback
 * (`src/control/control-service.ts`).
 *
 * `main.ts` throws this when the registry entry cannot be deleted. The
 * rollback distinguishes `in_use` (keep registration and directory, surface
 * the original Bot error) from any other failure (existing rollback).
 */
export type WorkspaceRemovalRefusal = "in_use" | "cwd_mismatch";

export class WorkspaceRemovalRefusedError extends Error {
  readonly reason: WorkspaceRemovalRefusal;

  readonly workspace: string;

  constructor(reason: WorkspaceRemovalRefusal, workspace: string, message: string) {
    super(message);
    this.name = "WorkspaceRemovalRefusedError";
    this.reason = reason;
    this.workspace = workspace;
  }
}

/** True for a refusal thrown by either the direct or the transaction remove. */
export function isWorkspaceRemovalRefused(error: unknown): error is WorkspaceRemovalRefusedError {
  if (error instanceof WorkspaceRemovalRefusedError) return true;
  if (typeof error !== "object" || error === null) return false;
  if (!("reason" in error) || !("workspace" in error) || !("name" in error)) return false;
  return error.name === "WorkspaceRemovalRefusedError"
    && (error.reason === "in_use" || error.reason === "cwd_mismatch")
    && typeof error.workspace === "string";
}
