/**
 * Session → engine affinity within the bridge host process (plan §3-R1).
 * Wave A: in-memory only, everything defaults to cli. Wave B wires the
 * persisted LogicalSession.transport_engine into setBinding().
 */
export class SessionEngineBinding {
  private readonly bindings = new Map<string, "cli" | "runtime">();

  constructor(private readonly defaultEngine: "cli" | "runtime" = "cli") {}

  engineFor(sessionKey: string): "cli" | "runtime" {
    return this.bindings.get(sessionKey) ?? this.defaultEngine;
  }

  hasExplicit(sessionKey: string): boolean {
    return this.bindings.has(sessionKey);
  }

  setBinding(sessionKey: string, engine: "cli" | "runtime"): void {
    this.bindings.set(sessionKey, engine);
  }
}
