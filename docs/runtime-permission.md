# Runtime Permission

`src/bridge/engine/runtime/runtime-permission-policy.ts` + `runtime-permission-resolver.ts` — xacpx-owned parser/resolver and live snapshot for the acpx Runtime.

- **Parser:** `XacpxPermissionPolicy` (`autoApprove`, `autoDeny`, `escalate: string[]`, `defaultAction: approve|deny|escalate`); JSON object only, `string[]` must be non-empty, unknown field → fail-closed, empty/unreadable file or inline invalid JSON → `RUNTIME_INIT_FAILED` (never fallback to `approve-all`). `isEligibleForRuntime` gates `nonInteractivePermissions=fail` and `escalate` → Runtime ineligible.
- **Resolver:** precedence `autoDeny → autoApprove → escalate → defaultAction → permissionMode` (`approve-all`/`deny-all`/`approve-reads` where only `inferredKind=read|search` approves, else `nonInteractivePermissions`). Glob via `globToRegExp` (`*`, `**`, `?`), no raw-text `read` guessing. `AbortSignal` → `reject_once`, exception → `reject_once`, never `undefined`.
- **Snapshot:** `RuntimePermissionConfig` (`generation`, `permissionMode`, `nonInteractivePermissions`, `permissionPolicy`) ; single source `configFromRaw` (no drift). Worker holds `permissionSnapshot`/`permissionGeneration`, `onPermissionRequest` reads snapshot.
- **Live update:** `EngineRouter` prepare (preflight `busy`/`acquiring` fail-closed) → `commit` validates, `generation++`, fans out `permission.update` (explicit `clearPermissionPolicy` for clear) to all live workers while holding transition lock; `ACK` kept, `fail` workers terminated (`lock` held) or `RUNTIME_WORKER_TEARDOWN_PENDING` if teardown also fails; new workers bootstrap with current generation via `ensure` `permissionGeneration`.

See `src/bridge/engine/runtime/runtime-worker-main.ts` and `tests/unit/bridge/engine/runtime/runtime-permission-*` for gates.
