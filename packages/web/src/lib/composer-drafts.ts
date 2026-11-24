/** Per-session composer draft persistence (borrowed from HAPI's composer-drafts).
 *  A half-typed message survives switching sessions or reloading the tab. Stored in
 *  sessionStorage (deliberately tab-scoped — dies with the tab) keyed by the
 *  instance+session key, or by `groupDraftKey` for a Group composer (one draft per
 *  Group + Topic). Empty text removes the key so the store doesn't grow. */
const KEY = "xacpx.composer-drafts.v1";

type Drafts = Record<string, string>;

function read(): Drafts {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Drafts) : {};
  } catch {
    return {};
  }
}

function write(drafts: Drafts): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(drafts));
  } catch {
    /* storage full / disabled — drafts are best-effort */
  }
}

/** Draft key for a Group composer: one draft per instance + Group + Topic.
 *  Namespaced so it can never collide with a session key in the same store.
 *  Returns "" (load/save become no-ops) until all three ids are known. */
export function groupDraftKey(
  instanceId: string | null | undefined,
  groupId: string | null | undefined,
  topicId: string | null | undefined,
): string {
  if (!instanceId || !groupId || !topicId) return "";
  return `group:${JSON.stringify([instanceId, groupId, topicId])}`;
}

export function loadDraft(draftKey: string): string {
  if (!draftKey) return "";
  return read()[draftKey] ?? "";
}

export function saveDraft(draftKey: string, text: string): void {
  if (!draftKey) return;
  const drafts = read();
  if (text) drafts[draftKey] = text;
  else delete drafts[draftKey];
  write(drafts);
}
