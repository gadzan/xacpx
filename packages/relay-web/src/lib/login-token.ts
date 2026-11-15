/** Presence of the key IS the remembered state: no value, no autofill, box unticked. */
const STORAGE_KEY = "xacpx.loginToken";

// Storage access throws when the browser has it disabled (Safari private mode, a
// blocked partition). That must cost the autofill, never the login form.
export function readRememberedToken(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function rememberToken(token: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // The session itself is a cookie, not this key, so a refused write costs
    // only the next autofill.
  }
}

export function forgetToken(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Already unreachable, so nothing can be left behind.
  }
}
