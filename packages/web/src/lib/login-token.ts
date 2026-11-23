// Storage access throws when the browser has it disabled (Safari private mode, a
// blocked partition). That must cost the autofill, never the login form.
const STORAGE_KEY = "xacpx.loginToken";

export function readRememberedToken(): string {
  try {
    const value = localStorage.getItem(STORAGE_KEY) ?? "";
    if (!value) localStorage.removeItem(STORAGE_KEY);
    return value;
  } catch {
    return "";
  }
}

export function rememberToken(token: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, token);
  } catch {
    /* ignore */
  }
}

export function forgetToken(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
