/** Per-session composer draft persistence (borrowed from HAPI's composer-drafts).
 *  A half-typed message survives switching sessions or reloading the tab. Stored in
 *  sessionStorage (deliberately tab-scoped — dies with the tab) keyed by the
 *  instance+session key. Empty text removes the key so the store doesn't grow. */
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
