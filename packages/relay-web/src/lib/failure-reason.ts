/**
 * Core failures are bare codes (`prompt_failed`, `runtime_revision_mismatch`);
 * provider errors arrive as sentences. Only sentences are worth showing.
 */
export function isMachineFailureReason(reason: string): boolean {
  return /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/.test(reason);
}
