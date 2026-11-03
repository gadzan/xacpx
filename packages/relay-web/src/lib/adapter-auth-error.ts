const ADAPTER_AUTH_PATTERN = /auth|login|unauthor|credential|sign[\s-]?in/i;

/** True when a raw adapter/bridge error is shaped like a missing host login. */
export function isAdapterAuthError(message: string): boolean {
  return ADAPTER_AUTH_PATTERN.test(message);
}
