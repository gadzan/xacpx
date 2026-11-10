// ADAPTER_AUTH_PATTERN matches a bare backend diagnostic, never the composed
// "model catalog refresh failed for agent …" prefix, whose session alias can contain
// auth-ish words. The English text comes from src/transport/acpx-model-inspector.ts
// (inspectorMessage) and the needs-setup copy in src/agents/capability-discovery.ts.
const ADAPTER_AUTH_PATTERN = /auth|login|unauthor|credential|sign[\s-]?in/i;
const COMPOSED_PROBE_DIAGNOSTIC = /^model catalog refresh failed for agent "[^"]*" session "[^"]*": ([\s\S]*)$/;

/** True when a raw error is shaped like a missing host login. */
export function isAdapterAuthError(message: string): boolean {
  return ADAPTER_AUTH_PATTERN.test(message);
}

/** True when a model-control diagnostic asks for a host login, ignoring the alias-bearing probe prefix. */
export function isAuthShapedModelError(detail: string): boolean {
  return isAdapterAuthError(COMPOSED_PROBE_DIAGNOSTIC.exec(detail)?.[1] ?? detail);
}
