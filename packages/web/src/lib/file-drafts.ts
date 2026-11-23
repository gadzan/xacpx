/** Per-session file edit-draft persistence (mirrors composer-drafts). An unsaved edit buffer
 *  survives a browser reload. Stored in sessionStorage (tab-scoped — dies with the tab) keyed
 *  by `${sessionKey}::${path}`, matching the center-tab's per-session identity. */
const KEY = "xacpx.file-drafts.v1";

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

export function draftKey(sessionKey: string, path: string): string {
  return `${sessionKey}::${path}`;
}

export function loadFileDraft(key: string): string | null {
  if (!key) return null;
  const v = read()[key];
  return v ?? null; // null = absent; "" = a real (emptied) draft
}

export function saveFileDraft(key: string, text: string): void {
  if (!key) return;
  const drafts = read();
  if (text) drafts[key] = text;
  else delete drafts[key];
  write(drafts);
}

export function clearFileDraft(key: string): void {
  if (!key) return;
  const drafts = read();
  delete drafts[key];
  write(drafts);
}
