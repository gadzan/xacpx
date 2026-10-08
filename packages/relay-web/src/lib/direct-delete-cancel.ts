/**
 * A declined unknown-result confirm is a normal cancel only when the server
 * explicitly says the Conversation is not in the deleting barrier. A missing
 * flag is treated as still deleting so a retry cannot hide a stuck Conversation.
 */
export function directDeleteDeclineIsCleanCancel(details: { deleting?: unknown } | undefined): boolean {
  return details?.deleting === false;
}
