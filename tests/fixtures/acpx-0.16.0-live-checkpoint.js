import { A as resolveAgentCommandParts, C as asAbsoluteCwd, E as isoNow$2, F as waitForSpawn, M as runTimedExecFile, N as splitCommandLine, P as waitForChildExit, S as PROCESS_HELPER_TIMEOUT_MS, T as isChildProcessRunning, _ as buildSpawnCommandOptions, b as readWindowsEnvValue, f as resolveBuiltInAgentLaunch, g as buildAgentSpawnCommand, j as resolveAgentSessionCwd, k as requireAgentStdio, n as AGENT_REGISTRY, r as BUILT_IN_AGENT_PACKAGES, t as AGENT_ARGV_REGISTRY, v as buildTerminalShellSpawnCommand, w as basenameToken, x as resolveWindowsExecutablePath, y as buildTerminalSpawnCommand } from "./agent-registry-DU6mhZBL.js";
import fs, { readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";
import fs$1 from "node:fs/promises";
import os from "node:os";
import { tempFile } from "@openclaw/fs-safe/advanced";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { PROTOCOL_VERSION, RequestError, client, methods } from "@agentclientprotocol/sdk";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { isPathInside } from "@openclaw/fs-safe/path";
import { root } from "@openclaw/fs-safe/root";
import readline from "node:readline/promises";
import { setTimeout as setTimeout$1 } from "node:timers/promises";
//#region src/errors.ts
var AcpxOperationalError = class extends Error {
	outputCode;
	detailCode;
	origin;
	retryable;
	acp;
	outputAlreadyEmitted;
	constructor(message, options) {
		super(message, options);
		this.name = new.target.name;
		this.outputCode = options?.outputCode;
		this.detailCode = options?.detailCode;
		this.origin = options?.origin;
		this.retryable = options?.retryable;
		this.acp = options?.acp;
		this.outputAlreadyEmitted = options?.outputAlreadyEmitted;
	}
};
var SessionNotFoundError = class extends AcpxOperationalError {
	sessionId;
	constructor(sessionId) {
		super(`Session not found: ${sessionId}`);
		this.sessionId = sessionId;
	}
};
var SessionResolutionError = class extends AcpxOperationalError {};
var AgentSpawnError = class extends AcpxOperationalError {
	agentCommand;
	constructor(agentCommand, cause) {
		const spawnEnoent = (cause instanceof Error ? cause.code : void 0) === "ENOENT";
		const message = spawnEnoent ? `Failed to spawn agent command: ${agentCommand}. The agent process could not start because a required executable, interpreter, working directory, or other launch path was not found. Check the command, effective PATH, and working directory, or verify the custom agent's configured argv.` : `Failed to spawn agent command: ${agentCommand}`;
		super(message, {
			cause: cause instanceof Error ? cause : void 0,
			...spawnEnoent ? { detailCode: "AGENT_SPAWN_ENOENT" } : {}
		});
		this.agentCommand = agentCommand;
	}
};
var AgentStartupError = class extends AcpxOperationalError {
	agentCommand;
	exitCode;
	signal;
	stderrSummary;
	constructor(params) {
		const exitSummary = `exit=${params.exitCode ?? "null"}, signal=${params.signal ?? "null"}`;
		const stderrSuffix = typeof params.stderrSummary === "string" && params.stderrSummary.trim().length > 0 ? `: ${params.stderrSummary.trim()}` : "";
		super(`ACP agent exited before initialize completed (${exitSummary})${stderrSuffix}`, {
			cause: params.cause instanceof Error ? params.cause : void 0,
			outputCode: "RUNTIME",
			detailCode: "AGENT_STARTUP_FAILED",
			origin: "acp"
		});
		this.agentCommand = params.agentCommand;
		this.exitCode = params.exitCode;
		this.signal = params.signal;
		this.stderrSummary = params.stderrSummary?.trim() || void 0;
	}
};
var AgentDisconnectedError = class extends AcpxOperationalError {
	reason;
	exitCode;
	signal;
	constructor(reason, exitCode, signal, options) {
		super(`ACP agent disconnected during request (${reason}, exit=${exitCode ?? "null"}, signal=${signal ?? "null"})`, {
			outputCode: "RUNTIME",
			detailCode: "AGENT_DISCONNECTED",
			origin: "acp",
			...options
		});
		this.reason = reason;
		this.exitCode = exitCode;
		this.signal = signal;
	}
};
var UnsupportedPromptContentError = class extends AcpxOperationalError {
	constructor(message) {
		super(message, {
			outputCode: "USAGE",
			detailCode: "UNSUPPORTED_PROMPT_CONTENT",
			origin: "acp"
		});
	}
};
var SessionResumeRequiredError = class extends AcpxOperationalError {
	constructor(message, options) {
		super(message, {
			outputCode: "RUNTIME",
			detailCode: "SESSION_RESUME_REQUIRED",
			origin: "acp",
			retryable: true,
			...options
		});
	}
};
var GeminiAcpStartupTimeoutError = class extends AcpxOperationalError {
	constructor(message, options) {
		super(message, {
			outputCode: "TIMEOUT",
			detailCode: "GEMINI_ACP_STARTUP_TIMEOUT",
			origin: "acp",
			...options
		});
	}
};
var SessionModeReplayError = class extends AcpxOperationalError {
	constructor(message, options) {
		super(message, {
			outputCode: "RUNTIME",
			detailCode: "SESSION_MODE_REPLAY_FAILED",
			origin: "acp",
			...options
		});
	}
};
var SessionModelReplayError = class extends AcpxOperationalError {
	constructor(message, options) {
		super(message, {
			outputCode: "RUNTIME",
			detailCode: "SESSION_MODEL_REPLAY_FAILED",
			origin: "acp",
			...options
		});
	}
};
var SessionConfigOptionReplayError = class extends AcpxOperationalError {
	constructor(message, options) {
		super(message, {
			outputCode: "RUNTIME",
			detailCode: "SESSION_CONFIG_OPTION_REPLAY_FAILED",
			origin: "acp",
			...options
		});
	}
};
var ClaudeAcpSessionCreateTimeoutError = class extends AcpxOperationalError {
	constructor(message, options) {
		super(message, {
			outputCode: "TIMEOUT",
			detailCode: "CLAUDE_ACP_SESSION_CREATE_TIMEOUT",
			origin: "acp",
			...options
		});
	}
};
var CopilotAcpUnsupportedError = class extends AcpxOperationalError {
	constructor(message, options) {
		super(message, {
			outputCode: "RUNTIME",
			detailCode: "COPILOT_ACP_UNSUPPORTED",
			origin: "acp",
			...options
		});
	}
};
var AuthPolicyError = class extends AcpxOperationalError {
	constructor(message, options) {
		super(message, {
			outputCode: "RUNTIME",
			detailCode: "AUTH_REQUIRED",
			origin: "acp",
			...options
		});
	}
};
var QueueConnectionError = class extends AcpxOperationalError {};
var QueueProtocolError = class extends AcpxOperationalError {};
var PermissionDeniedError = class extends AcpxOperationalError {};
var PermissionPromptUnavailableError = class extends AcpxOperationalError {
	constructor() {
		super("Permission prompt unavailable in non-interactive mode");
	}
};
//#endregion
//#region src/types.ts
const EXIT_CODES = {
	SUCCESS: 0,
	ERROR: 1,
	USAGE: 2,
	TIMEOUT: 3,
	NO_SESSION: 4,
	PERMISSION_DENIED: 5,
	INTERRUPTED: 130
};
const OUTPUT_FORMATS = [
	"text",
	"json",
	"quiet"
];
const PERMISSION_MODES = [
	"approve-all",
	"approve-reads",
	"deny-all"
];
const AUTH_POLICIES = ["skip", "fail"];
const NON_INTERACTIVE_PERMISSION_POLICIES = ["deny", "fail"];
const PERMISSION_POLICY_ACTIONS = [
	"approve",
	"deny",
	"escalate"
];
const OUTPUT_ERROR_CODES = [
	"NO_SESSION",
	"TIMEOUT",
	"PERMISSION_DENIED",
	"PERMISSION_PROMPT_UNAVAILABLE",
	"RUNTIME",
	"USAGE"
];
const OUTPUT_ERROR_ORIGINS = [
	"cli",
	"runtime",
	"queue",
	"acp"
];
const SESSION_RECORD_SCHEMA = "acpx.session.v1";
//#endregion
//#region src/acp/error-shapes.ts
const RESOURCE_NOT_FOUND_ACP_CODES = /* @__PURE__ */ new Set([-32001, -32002]);
function asRecord$8(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return value;
}
function toAcpErrorPayload(value) {
	const record = asRecord$8(value);
	if (!record) return;
	if (typeof record.code !== "number" || !Number.isFinite(record.code)) return;
	if (typeof record.message !== "string" || record.message.length === 0) return;
	return {
		code: record.code,
		message: record.message,
		data: record.data
	};
}
function extractAcpErrorInternal(value, depth) {
	if (depth > 5) return;
	const direct = toAcpErrorPayload(value);
	if (direct) return direct;
	const record = asRecord$8(value);
	if (!record) return;
	return extractNestedAcpError(record, depth);
}
function extractNestedAcpError(record, depth) {
	for (const key of [
		"error",
		"acp",
		"cause"
	]) if (key in record) {
		const nested = extractAcpErrorInternal(record[key], depth + 1);
		if (nested) return nested;
	}
}
function formatUnknownErrorMessage(error) {
	if (error instanceof Error) return error.message;
	if (error && typeof error === "object") {
		const maybeMessage = error.message;
		if (typeof maybeMessage === "string" && maybeMessage.length > 0) return maybeMessage;
		try {
			return JSON.stringify(error);
		} catch {}
	}
	return String(error);
}
const SESSION_NOT_FOUND_PATTERN = /session\s+["'\w-]+\s+not found/i;
function isSessionNotFoundText(value) {
	if (typeof value !== "string") return false;
	const normalized = value.toLowerCase();
	return normalized.includes("resource_not_found") || normalized.includes("resource not found") || normalized.includes("session not found") || normalized.includes("unknown session") || normalized.includes("invalid session identifier") || SESSION_NOT_FOUND_PATTERN.test(value);
}
function hasSessionNotFoundHint(value, depth = 0) {
	if (depth > 4) return false;
	if (isSessionNotFoundText(value)) return true;
	if (Array.isArray(value)) return value.some((entry) => hasSessionNotFoundHint(entry, depth + 1));
	const record = asRecord$8(value);
	if (!record) return false;
	return Object.values(record).some((entry) => hasSessionNotFoundHint(entry, depth + 1));
}
function extractAcpError(error) {
	return extractAcpErrorInternal(error, 0);
}
function isAcpResourceNotFoundError(error) {
	const acp = extractAcpError(error);
	if (acp && RESOURCE_NOT_FOUND_ACP_CODES.has(acp.code)) return true;
	if (acp) {
		if (isSessionNotFoundText(acp.message)) return true;
		if (hasSessionNotFoundHint(acp.data)) return true;
	}
	return isSessionNotFoundText(formatUnknownErrorMessage(error));
}
//#endregion
//#region src/acp/error-normalization.ts
const AUTH_REQUIRED_ACP_CODES = /* @__PURE__ */ new Set([-32e3]);
const QUERY_CLOSED_BEFORE_RESPONSE_DETAIL = "query closed before response received";
function asRecord$7(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return value;
}
function isAuthRequiredMessage(value) {
	if (!value) return false;
	const normalized = value.toLowerCase();
	return [
		"auth required",
		"authentication required",
		"authorization required",
		"credential required",
		"credentials required",
		"token required",
		"login required"
	].some((needle) => normalized.includes(needle));
}
function isAcpAuthRequiredPayload(acp) {
	if (!acp) return false;
	if (!AUTH_REQUIRED_ACP_CODES.has(acp.code)) return false;
	if (isAuthRequiredMessage(acp.message)) return true;
	const data = asRecord$7(acp.data);
	if (!data) return false;
	return hasAuthRequiredData(data);
}
function hasAuthRequiredData(data) {
	return data.authRequired === true || hasNonEmptyString(data.methodId) || hasNonEmptyArray(data.methods);
}
function hasNonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0;
}
function hasNonEmptyArray(value) {
	return Array.isArray(value) && value.length > 0;
}
function isOutputErrorCode(value) {
	return typeof value === "string" && OUTPUT_ERROR_CODES.includes(value);
}
function isOutputErrorOrigin(value) {
	return typeof value === "string" && OUTPUT_ERROR_ORIGINS.includes(value);
}
function readOutputErrorMeta(error) {
	const record = asRecord$7(error);
	if (!record) return {};
	return {
		outputCode: isOutputErrorCode(record.outputCode) ? record.outputCode : void 0,
		detailCode: typeof record.detailCode === "string" && record.detailCode.trim().length > 0 ? record.detailCode : void 0,
		origin: isOutputErrorOrigin(record.origin) ? record.origin : void 0,
		retryable: typeof record.retryable === "boolean" ? record.retryable : void 0,
		acp: extractAcpError(record.acp)
	};
}
function isTimeoutLike(error) {
	return error instanceof Error && error.name === "TimeoutError";
}
function isNoSessionLike(error) {
	return error instanceof Error && error.name === "NoSessionError";
}
function isUsageLike(error) {
	if (!(error instanceof Error)) return false;
	return error.name === "CommanderError" || error.name === "InvalidArgumentError" || asRecord$7(error)?.code === "commander.invalidArgument";
}
function formatErrorMessage(error) {
	return formatUnknownErrorMessage(error);
}
function isAcpQueryClosedBeforeResponseError(error) {
	const acp = extractAcpError(error);
	if (!acp || acp.code !== -32603) return false;
	const details = asRecord$7(acp.data)?.details;
	if (typeof details !== "string") return false;
	return details.toLowerCase().includes(QUERY_CLOSED_BEFORE_RESPONSE_DETAIL);
}
function mapErrorCode(error) {
	if (error instanceof PermissionPromptUnavailableError) return "PERMISSION_PROMPT_UNAVAILABLE";
	if (error instanceof PermissionDeniedError) return "PERMISSION_DENIED";
	if (isTimeoutLike(error)) return "TIMEOUT";
	if (isNoSessionLike(error) || isAcpResourceNotFoundError(error)) return "NO_SESSION";
	if (isUsageLike(error)) return "USAGE";
}
function normalizeOutputError(error, options = {}) {
	const meta = readOutputErrorMeta(error);
	const code = resolveOutputErrorCode(error, options, meta);
	const acp = options.acp ?? meta.acp ?? extractAcpError(error);
	return {
		code,
		message: formatErrorMessage(error),
		detailCode: resolveDetailCode(error, acp, options, meta),
		origin: meta.origin ?? options.origin,
		retryable: meta.retryable ?? options.retryable,
		acp
	};
}
function resolveOutputErrorCode(error, options, meta) {
	const code = meta.outputCode ?? mapErrorCode(error) ?? options.defaultCode ?? "RUNTIME";
	if (code === "RUNTIME" && isAcpResourceNotFoundError(error)) return "NO_SESSION";
	return code;
}
function resolveDetailCode(error, acp, options, meta) {
	return meta.detailCode ?? options.detailCode ?? (error instanceof AuthPolicyError || isAcpAuthRequiredPayload(acp) ? "AUTH_REQUIRED" : void 0);
}
/**
* Returns true when an error from `client.prompt()` looks transient and
* can reasonably be retried (e.g. model-API 400/500, network hiccups that
* surface as ACP internal errors).
*
* Errors that are definitively non-recoverable (auth, missing session,
* invalid params, timeout, permission) return false.
*/
function isRetryablePromptError(error) {
	if (isNonRetryablePromptError(error)) return false;
	const acp = extractAcpError(error);
	if (!acp) return false;
	return acp.code === -32603 || acp.code === -32700;
}
function isNonRetryablePromptError(error) {
	return error instanceof PermissionDeniedError || error instanceof PermissionPromptUnavailableError || isTimeoutLike(error) || isNoSessionLike(error) || isUsageLike(error);
}
function exitCodeForOutputErrorCode(code) {
	switch (code) {
		case "USAGE": return EXIT_CODES.USAGE;
		case "TIMEOUT": return EXIT_CODES.TIMEOUT;
		case "NO_SESSION": return EXIT_CODES.NO_SESSION;
		case "PERMISSION_DENIED":
		case "PERMISSION_PROMPT_UNAVAILABLE": return EXIT_CODES.PERMISSION_DENIED;
		default: return EXIT_CODES.ERROR;
	}
}
//#endregion
//#region src/async-control.ts
var TimeoutError = class extends Error {
	constructor(timeoutMs) {
		super(`Timed out after ${timeoutMs}ms`);
		this.name = "TimeoutError";
	}
};
var InterruptedError = class extends Error {
	constructor() {
		super("Interrupted");
		this.name = "InterruptedError";
	}
};
async function withTimeout(promise, timeoutMs) {
	if (timeoutMs == null || timeoutMs <= 0) return await promise;
	let timer;
	const timeoutPromise = new Promise((_resolve, reject) => {
		timer = setTimeout(() => {
			reject(new TimeoutError(timeoutMs));
		}, timeoutMs);
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
async function withInterrupt(run, onInterrupt) {
	return await new Promise((resolve, reject) => {
		let settled = false;
		const finish = (cb) => {
			if (settled) return;
			settled = true;
			process.off("SIGINT", onSigint);
			process.off("SIGTERM", onSigterm);
			process.off("SIGHUP", onSighup);
			cb();
		};
		const rejectInterrupted = (signal) => {
			onInterrupt(signal).then(() => finish(() => reject(new InterruptedError())), (error) => finish(() => reject(error)));
		};
		const onSigint = () => {
			rejectInterrupted("SIGINT");
		};
		const onSigterm = () => {
			rejectInterrupted("SIGTERM");
		};
		const onSighup = () => {
			rejectInterrupted("SIGHUP");
		};
		process.once("SIGINT", onSigint);
		process.once("SIGTERM", onSigterm);
		process.once("SIGHUP", onSighup);
		run().then((result) => finish(() => resolve(result)), (error) => finish(() => reject(error)));
	});
}
//#endregion
//#region src/acp/codex-compat.ts
function isLegacyZedCodexAcpInvocation(agentCommand) {
	return /@zed-industries\/codex-acp\b/u.test(agentCommand);
}
function preferCodexPermissionRefusal(request, agentName) {
	if (agentName !== "@agentclientprotocol/codex-acp") return request;
	const preferred = request.options.find((option) => option.kind === "reject_once" && ["decline", "reject_permissions"].includes(option.optionId));
	return preferred ? {
		...request,
		options: [preferred, ...request.options.filter((option) => option !== preferred)]
	} : request;
}
function codexPermissionNotice(request, response, agentName) {
	if (agentName !== "@agentclientprotocol/codex-acp") return;
	if (response.outcome.outcome === "cancelled") return "No matching permission option was available. The request was safely cancelled; Codex may end the current turn.";
	const selectedId = response.outcome.optionId;
	return request.options.find((option) => option.optionId === selectedId)?.kind === "reject_once" && selectedId === "cancel" ? "Permission refused using Codex's cancellation option; this can end the current turn. The operation was not approved." : void 0;
}
//#endregion
//#region src/acp/jsonrpc.ts
function asRecord$6(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value;
}
function isAcpMessageObject(value) {
	return asRecord$6(value) !== null;
}
function hasValidId(value) {
	return value === null || typeof value === "string" || typeof value === "number" && Number.isFinite(value);
}
function isErrorObject(value) {
	const record = asRecord$6(value);
	return !!record && typeof record.code === "number" && Number.isFinite(record.code) && typeof record.message === "string";
}
function hasResultOrError(value) {
	const hasResult = Object.hasOwn(value, "result");
	const hasError = Object.hasOwn(value, "error");
	if (hasResult && hasError) return false;
	if (!hasResult && !hasError) return false;
	if (hasError && !isErrorObject(value.error)) return false;
	return true;
}
function hasMethod(value) {
	return typeof value.method === "string" && value.method.length > 0;
}
function isJsonRpcRequest(value) {
	return hasMethod(value) && Object.hasOwn(value, "id") && hasValidId(value.id);
}
function isJsonRpcNotificationRecord(value) {
	return hasMethod(value) && !Object.hasOwn(value, "id");
}
function isJsonRpcResponse(value) {
	if (hasMethod(value) || !Object.hasOwn(value, "id") || !hasValidId(value.id)) return false;
	return hasResultOrError(value);
}
function isAcpJsonRpcMessage(value) {
	const record = asRecord$6(value);
	if (!record || record.jsonrpc !== "2.0") return false;
	return isJsonRpcNotificationRecord(record) || isJsonRpcRequest(record) || isJsonRpcResponse(record);
}
function isJsonRpcNotification(message) {
	return Object.hasOwn(message, "method") && typeof message.method === "string" && !Object.hasOwn(message, "id");
}
function isSessionUpdateNotification(message) {
	return isJsonRpcNotification(message) && message.method === "session/update";
}
function extractSessionUpdateNotification(message) {
	if (!isSessionUpdateNotification(message)) return;
	const params = asRecord$6(message.params);
	if (!params) return;
	const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
	if (!sessionId) return;
	const update = asRecord$6(params.update);
	if (!update || typeof update.sessionUpdate !== "string") return;
	return {
		sessionId,
		update
	};
}
function parsePromptStopReason(message) {
	if (!Object.hasOwn(message, "id") || !Object.hasOwn(message, "result")) return;
	const record = asRecord$6(message.result);
	if (!record) return;
	return typeof record.stopReason === "string" ? record.stopReason : void 0;
}
function parsePermissionNotice(message) {
	if (!Object.hasOwn(message, "id") || !Object.hasOwn(message, "result")) return;
	const notice = asRecord$6(asRecord$6(asRecord$6(message.result)?._meta)?.acpx)?.permissionNotice;
	return typeof notice === "string" ? notice : void 0;
}
function parseJsonRpcErrorMessage(message) {
	if (!Object.hasOwn(message, "error")) return;
	const errorRecord = asRecord$6(message.error);
	if (!errorRecord || typeof errorRecord.message !== "string") return;
	return errorRecord.message;
}
//#endregion
//#region src/process-liveness.ts
function isProcessAlive(pid) {
	if (!pid || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
//#endregion
//#region \0@oxc-project+runtime@0.149.0/helpers/esm/usingCtx.js
function _usingCtx() {
	var r = "function" == typeof SuppressedError ? SuppressedError : function(r, e) {
		var n = Error();
		return n.name = "SuppressedError", n.error = r, n.suppressed = e, n;
	}, e = {}, n = [];
	function using(r, e) {
		if (null != e) {
			if (Object(e) !== e) throw new TypeError("using declarations can only be used with objects, functions, null, or undefined.");
			if (r) var o = e[Symbol.asyncDispose || Symbol["for"]("Symbol.asyncDispose")];
			if (void 0 === o && (o = e[Symbol.dispose || Symbol["for"]("Symbol.dispose")], r)) var t = o;
			if ("function" != typeof o) throw new TypeError("Object is not disposable.");
			t && (o = function o() {
				try {
					t.call(e);
				} catch (r) {
					return Promise.reject(r);
				}
			}), n.push({
				v: e,
				d: o,
				a: r
			});
		} else r && n.push({
			d: e,
			a: r
		});
		return e;
	}
	return {
		e,
		u: using.bind(null, !1),
		a: using.bind(null, !0),
		d: function d() {
			var o, t = this.e, s = 0;
			function next() {
				for (; o = n.pop();) try {
					if (!o.a && 1 === s) return s = 0, n.push(o), Promise.resolve().then(next);
					if (o.d) {
						var r = o.d.call(o.v);
						if (o.a) return s |= 2, Promise.resolve(r).then(next, err);
					} else s |= 1;
				} catch (r) {
					return err(r);
				}
				if (1 === s) return t !== e ? Promise.reject(t) : Promise.resolve();
				if (t !== e) throw t;
			}
			function err(n) {
				return t = t !== e ? new r(n, t) : n, next();
			}
			return next();
		}
	};
}
//#endregion
//#region src/state-files.ts
async function writePrivateFile(filePath, content, options = {}) {
	try {
		var _usingCtx$1 = _usingCtx();
		const privateDirectory = options.privateDirectory !== false;
		await fs$1.mkdir(path.dirname(filePath), {
			recursive: true,
			mode: privateDirectory ? 448 : void 0
		});
		const directory = await fs$1.realpath(path.dirname(filePath));
		if (privateDirectory && process.platform !== "win32") await fs$1.chmod(directory, 448);
		const temporary = _usingCtx$1.a(await tempFile({
			rootDir: directory,
			prefix: "acpx-write",
			fileName: "record.json"
		}));
		const handle = await fs$1.open(temporary.path, "wx", 384);
		try {
			await handle.writeFile(content, "utf8");
			await handle.chmod(384);
		} finally {
			await handle.close();
		}
		await fs$1.rename(temporary.path, path.join(directory, path.basename(filePath)));
	} catch (_) {
		_usingCtx$1.e = _;
	} finally {
		await _usingCtx$1.d();
	}
}
async function writePrivateJsonFile(filePath, value) {
	await writePrivateFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
//#endregion
//#region src/session/event-log.ts
const DEFAULT_EVENT_SEGMENT_MAX_BYTES = 67108864;
function sessionBaseDir() {
	return path.join(os.homedir(), ".acpx", "sessions");
}
function safeSessionId(sessionId) {
	return encodeURIComponent(sessionId);
}
function sessionEventActivePath(sessionId) {
	return path.join(sessionBaseDir(), `${safeSessionId(sessionId)}.stream.ndjson`);
}
function sessionEventSegmentPath(sessionId, segment) {
	return path.join(sessionBaseDir(), `${safeSessionId(sessionId)}.stream.${segment}.ndjson`);
}
function sessionEventLockPath(sessionId) {
	return path.join(sessionBaseDir(), `${safeSessionId(sessionId)}.stream.lock`);
}
function defaultSessionEventLog(sessionId) {
	return {
		active_path: sessionEventActivePath(sessionId),
		segment_count: 5,
		max_segment_bytes: DEFAULT_EVENT_SEGMENT_MAX_BYTES,
		max_segments: 5,
		last_write_at: void 0,
		last_write_error: null
	};
}
//#endregion
//#region src/acp/agent-session-id.ts
const AGENT_SESSION_ID_META_KEYS = ["agentSessionId", "sessionId"];
function normalizeAgentSessionId(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function asMetaRecord(meta) {
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return;
	return meta;
}
function extractAgentSessionId(meta) {
	const record = asMetaRecord(meta);
	if (!record) return;
	for (const key of AGENT_SESSION_ID_META_KEYS) {
		const normalized = normalizeAgentSessionId(record[key]);
		if (normalized) return normalized;
	}
}
//#endregion
//#region src/session/persistence/serialize.ts
function serializeSessionRecordForDisk(record) {
	return {
		schema: SESSION_RECORD_SCHEMA,
		acpx_record_id: record.acpxRecordId,
		acp_session_id: record.acpSessionId,
		agent_session_id: normalizeAgentSessionId(record.agentSessionId),
		agent_command: record.agentCommand,
		agent_argv: record.agentArgv,
		cwd: record.cwd,
		name: record.name,
		created_at: record.createdAt,
		last_used_at: record.lastUsedAt,
		last_seq: record.lastSeq,
		last_request_id: record.lastRequestId,
		event_log: record.eventLog,
		closed: record.closed,
		closed_at: record.closedAt,
		pid: record.pid,
		agent_started_at: record.agentStartedAt,
		last_prompt_at: record.lastPromptAt,
		last_agent_exit_code: record.lastAgentExitCode,
		last_agent_exit_signal: record.lastAgentExitSignal,
		last_agent_exit_at: record.lastAgentExitAt,
		last_agent_disconnect_reason: record.lastAgentDisconnectReason,
		protocol_version: record.protocolVersion,
		agent_capabilities: record.agentCapabilities,
		title: record.title,
		messages: record.messages,
		updated_at: record.updated_at,
		cumulative_token_usage: record.cumulative_token_usage,
		cumulative_cost: record.cumulative_cost,
		request_token_usage: record.request_token_usage,
		acpx: record.acpx,
		imported_from: record.importedFrom ? {
			record_id: record.importedFrom.recordId,
			cwd_original: record.importedFrom.cwdOriginal,
			exported_by: record.importedFrom.exportedBy,
			exported_at: record.importedFrom.exportedAt
		} : void 0
	};
}
//#endregion
//#region src/acp/builtin-command-migration.ts
const LEGACY_AGENT_COMMANDS = {
	pi: [
		"npx pi-acp",
		"npx pi-acp@^0.0.22",
		"npx pi-acp@^0.0.26"
	],
	codex: [
		"npx @zed-industries/codex-acp",
		"npx @zed-industries/codex-acp@^0.9.5",
		"npx @zed-industries/codex-acp@^0.10.0",
		"npx @zed-industries/codex-acp@^0.11.1",
		"npx @zed-industries/codex-acp@^0.12.0",
		"npx -y @agentclientprotocol/codex-acp@^0.0.44",
		"npx -y @agentclientprotocol/codex-acp@^1.1.4"
	],
	claude: [
		"npx @zed-industries/claude-agent-acp",
		"npx -y @zed-industries/claude-agent-acp",
		"npx -y @zed-industries/claude-agent-acp@^0.21.0",
		"npx -y @zed-industries/claude-agent-acp@^0.23.1",
		"npx -y @zed-industries/claude-agent-acp@^0.24.2",
		"npx -y @zed-industries/claude-agent-acp@^0.25.0",
		"npx -y @zed-industries/claude-agent-acp@^0.31.0",
		"npx -y @agentclientprotocol/claude-agent-acp@^0.36.1",
		"npx -y @agentclientprotocol/claude-agent-acp@^0.37.0",
		"npm exec @agentclientprotocol/claude-agent-acp@^0.36.1",
		"npm exec @agentclientprotocol/claude-agent-acp@^0.37.0"
	],
	gemini: ["gemini", "gemini --experimental-acp"],
	kiro: ["kiro-cli acp"],
	mux: ["npx -y mux@^0.27.0 acp"],
	opencode: ["npx opencode-ai"]
};
function currentArgv(name) {
	const argv = AGENT_ARGV_REGISTRY[name];
	return argv ? [...argv] : void 0;
}
function resolveAgentArgvForCommand(agentCommand) {
	for (const [name, command] of Object.entries(AGENT_REGISTRY)) if (command === agentCommand) return currentArgv(name);
	for (const [name, spec] of Object.entries(BUILT_IN_AGENT_PACKAGES)) if ((spec.legacyFallbackCommands ?? []).includes(agentCommand)) return currentArgv(name);
	for (const [name, commands] of Object.entries(LEGACY_AGENT_COMMANDS)) if (commands.includes(agentCommand)) return currentArgv(name);
}
//#endregion
//#region src/session/persistence/parse.ts
function asRecord$5(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return value;
}
function hasOwn$1(source, key) {
	return Object.prototype.hasOwnProperty.call(source, key);
}
function isStringArray(value) {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
function parseOptionalAgentArgv(value) {
	return isStringArray(value) && value.length > 0 && value[0]?.length > 0 ? value : void 0;
}
function parsePersistedAgentArgv(record) {
	return parseOptionalAgentArgv(record.agent_argv) ?? (typeof record.agent_command === "string" ? resolveAgentArgvForCommand(record.agent_command) : void 0);
}
function hasModelConfigOption(options) {
	if (!Array.isArray(options)) return false;
	return options.some((entry) => {
		const option = asRecord$5(entry);
		return option?.category === "model" || option?.id === "model";
	});
}
function parseConfigOptions(raw) {
	if (!Array.isArray(raw) || !raw.every((entry) => asRecord$5(entry) !== void 0)) return;
	return raw;
}
function parseAvailableCommand(raw) {
	if (typeof raw === "string") {
		const name = raw.trim();
		return name ? { name } : void 0;
	}
	const record = asRecord$5(raw);
	if (!record) return;
	const name = parseNonEmptyString(record.name);
	if (!name) return;
	const description = parseNonEmptyString(record.description);
	return {
		name,
		...description ? { description } : {},
		...typeof record.has_input === "boolean" ? { has_input: record.has_input } : {}
	};
}
function parseAvailableCommands(raw) {
	if (!Array.isArray(raw)) return;
	const commands = raw.map((entry) => parseAvailableCommand(entry)).filter((entry) => entry !== void 0);
	return commands.length > 0 ? commands : void 0;
}
function parseNonEmptyString(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed ? trimmed : void 0;
}
function parseTokenUsage(raw) {
	if (raw === void 0 || raw === null) return;
	const record = asRecord$5(raw);
	if (!record) return null;
	const usage = {};
	for (const field of [
		"input_tokens",
		"output_tokens",
		"cache_creation_input_tokens",
		"cache_read_input_tokens",
		"thought_tokens",
		"total_tokens"
	]) {
		const value = record[field];
		if (value === void 0) continue;
		if (!isNonNegativeFiniteNumber(value)) return null;
		usage[field] = value;
	}
	return usage;
}
function isNonNegativeFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function parseUsageCost(raw) {
	if (raw === void 0 || raw === null) return;
	const record = asRecord$5(raw);
	if (!record) return null;
	return parseUsageCostRecord(record);
}
function parseUsageCostRecord(record) {
	const amount = parseCostAmount(record.amount);
	const currency = parseCostCurrency(record.currency);
	if (amount === null || currency === null) return null;
	const cost = {
		...amount !== void 0 ? { amount } : {},
		...currency !== void 0 ? { currency } : {}
	};
	return Object.keys(cost).length > 0 ? cost : void 0;
}
function parseCostAmount(value) {
	if (value === void 0) return;
	return isNonNegativeFiniteNumber(value) ? value : null;
}
function parseCostCurrency(value) {
	if (value === void 0) return;
	if (typeof value !== "string") return null;
	const currency = value.trim();
	return currency.length > 0 ? currency : void 0;
}
function parseRequestTokenUsage(raw) {
	if (raw === void 0 || raw === null) return;
	const record = asRecord$5(raw);
	if (!record) return null;
	const usage = {};
	for (const [key, value] of Object.entries(record)) {
		const parsed = parseTokenUsage(value);
		if (parsed == null) return null;
		usage[key] = parsed;
	}
	return usage;
}
function isSessionMessageImage(raw) {
	const record = asRecord$5(raw);
	if (!record || typeof record.source !== "string") return false;
	if (record.size === void 0 || record.size === null) return true;
	const size = asRecord$5(record.size);
	return !!size && isFiniteNumber(size.width) && isFiniteNumber(size.height);
}
function isSessionMessageAudio(raw) {
	const record = asRecord$5(raw);
	return !!record && typeof record.source === "string" && typeof record.mime_type === "string";
}
function isFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}
function isUserContent(raw) {
	const record = asRecord$5(raw);
	if (!record) return false;
	if (typeof record.Text === "string") return true;
	if (record.Mention !== void 0) {
		const mention = asRecord$5(record.Mention);
		return !!mention && typeof mention.uri === "string" && typeof mention.content === "string";
	}
	if (record.Image !== void 0) return isSessionMessageImage(record.Image);
	if (record.Audio !== void 0) return isSessionMessageAudio(record.Audio);
	return false;
}
function isToolUse(raw) {
	const record = asRecord$5(raw);
	return !!record && hasStringFields(record, [
		"id",
		"name",
		"raw_input"
	]) && hasOwn$1(record, "input") && typeof record.is_input_complete === "boolean" && isOptionalString(record.thought_signature);
}
function hasStringFields(record, keys) {
	return keys.every((key) => typeof record[key] === "string");
}
function isOptionalString(value) {
	return value === void 0 || value === null || typeof value === "string";
}
function isToolResultContent(raw) {
	const record = asRecord$5(raw);
	if (!record) return false;
	if (typeof record.Text === "string") return true;
	if (record.Image !== void 0) return isSessionMessageImage(record.Image);
	return false;
}
function isToolResult(raw) {
	const record = asRecord$5(raw);
	return !!record && typeof record.tool_use_id === "string" && typeof record.tool_name === "string" && typeof record.is_error === "boolean" && isToolResultContent(record.content);
}
function isAgentContent(raw) {
	const record = asRecord$5(raw);
	if (!record) return false;
	if (typeof record.Text === "string") return true;
	if (record.Thinking !== void 0) return isThinkingContent(record.Thinking);
	if (typeof record.RedactedThinking === "string") return true;
	if (record.ToolUse !== void 0) return isToolUse(record.ToolUse);
	return false;
}
function isThinkingContent(raw) {
	const thinking = asRecord$5(raw);
	return !!thinking && typeof thinking.text === "string" && isOptionalString(thinking.signature);
}
function isUserMessage$1(raw) {
	const record = asRecord$5(raw);
	if (!record || record.User === void 0) return false;
	const user = asRecord$5(record.User);
	return !!user && typeof user.id === "string" && Array.isArray(user.content) && user.content.every((entry) => isUserContent(entry));
}
function isAgentMessage$1(raw) {
	const record = asRecord$5(raw);
	if (!record || record.Agent === void 0) return false;
	const agent = asRecord$5(record.Agent);
	if (!agent || !Array.isArray(agent.content) || !agent.content.every(isAgentContent)) return false;
	const toolResults = asRecord$5(agent.tool_results);
	if (!toolResults) return false;
	return Object.values(toolResults).every(isToolResult);
}
function isConversationMessage(raw) {
	return raw === "Resume" || isUserMessage$1(raw) || isAgentMessage$1(raw);
}
function parseConversationRecord(record) {
	if (!hasValidConversationCore(record)) return;
	const title = parseConversationTitle(record.title);
	if (title === INVALID_VALUE) return;
	const cumulativeTokenUsage = parseTokenUsage(record.cumulative_token_usage);
	const cumulativeCost = parseUsageCost(record.cumulative_cost);
	const requestTokenUsage = parseRequestTokenUsage(record.request_token_usage);
	if (cumulativeTokenUsage === null || cumulativeCost === null || requestTokenUsage === null) return;
	return {
		title,
		messages: record.messages,
		updated_at: record.updated_at,
		cumulative_token_usage: cumulativeTokenUsage ?? {},
		cumulative_cost: cumulativeCost,
		request_token_usage: requestTokenUsage ?? {}
	};
}
const INVALID_VALUE = Symbol("invalid");
function parseConversationTitle(value) {
	if (value === void 0 || value === null || typeof value === "string") return value;
	return INVALID_VALUE;
}
function hasValidConversationCore(record) {
	return Array.isArray(record.messages) && record.messages.every(isConversationMessage) && typeof record.updated_at === "string";
}
function parseAcpxState(raw) {
	const record = asRecord$5(raw);
	if (!record) return;
	const state = {};
	if (record.reset_on_next_ensure === true) state.reset_on_next_ensure = true;
	assignStringState(state, "current_mode_id", record.current_mode_id);
	assignStringState(state, "desired_mode_id", record.desired_mode_id);
	const desiredConfigOptions = parseStringMap(record.desired_config_options);
	if (desiredConfigOptions) state.desired_config_options = desiredConfigOptions;
	const modelNames = parseStringMap(record.available_model_names, true);
	if (modelNames) state.available_model_names = modelNames;
	assignParsedModelState(state, record);
	const availableCommands = parseAvailableCommands(record.available_commands);
	if (availableCommands) state.available_commands = availableCommands;
	assignParsedSessionOptions(state, record.session_options);
	return state;
}
function assignParsedModelState(state, record) {
	assignStringState(state, "current_model_id", record.current_model_id);
	if (isStringArray(record.available_models)) state.available_models = [...record.available_models];
	if (record.model_control === "config_option" || record.model_control === "legacy_set_model") state.model_control = record.model_control;
	const configOptions = parseConfigOptions(record.config_options);
	if (configOptions) state.config_options = configOptions;
	if (state.model_control === void 0 && state.available_models !== void 0) state.model_control = hasModelConfigOption(state.config_options) ? "config_option" : "legacy_set_model";
}
function assignStringState(state, key, value) {
	if (typeof value === "string") state[key] = value;
}
function parseStringMap(raw, preserveEmpty = false) {
	const record = asRecord$5(raw);
	if (!record) return;
	const parsed = Object.fromEntries(Object.entries(record).filter((entry) => typeof entry[1] === "string"));
	return Object.keys(parsed).length > 0 || preserveEmpty ? parsed : void 0;
}
function assignParsedSessionOptions(state, raw) {
	const sessionOptions = asRecord$5(raw);
	if (!sessionOptions) return;
	const parsedSessionOptions = {};
	if (typeof sessionOptions.model === "string") parsedSessionOptions.model = sessionOptions.model;
	if (isStringArray(sessionOptions.allowed_tools)) parsedSessionOptions.allowed_tools = [...sessionOptions.allowed_tools];
	if (isPositiveInteger(sessionOptions.max_turns)) parsedSessionOptions.max_turns = sessionOptions.max_turns;
	assignSessionOptionSystemPrompt(parsedSessionOptions, sessionOptions.system_prompt);
	const env = parseStringMap(sessionOptions.env);
	if (env) parsedSessionOptions.env = env;
	if (Object.keys(parsedSessionOptions).length > 0) state.session_options = parsedSessionOptions;
}
function assignSessionOptionSystemPrompt(options, value) {
	if (typeof value === "string" && value.length > 0) {
		options.system_prompt = value;
		return;
	}
	const appendRecord = asRecord$5(value);
	if (appendRecord && typeof appendRecord.append === "string" && appendRecord.append.length > 0) options.system_prompt = { append: appendRecord.append };
}
function parseEventLog(raw, sessionId) {
	const record = asRecord$5(raw);
	if (!record || !hasValidEventLogCore(record)) return defaultSessionEventLog(sessionId);
	return {
		active_path: record.active_path,
		segment_count: record.segment_count,
		max_segment_bytes: record.max_segment_bytes,
		max_segments: record.max_segments,
		last_write_at: typeof record.last_write_at === "string" ? record.last_write_at : void 0,
		last_write_error: record.last_write_error == null || typeof record.last_write_error === "string" ? record.last_write_error : null
	};
}
function hasValidEventLogCore(record) {
	return typeof record.active_path === "string" && isPositiveInteger(record.segment_count) && isPositiveInteger(record.max_segment_bytes) && isPositiveInteger(record.max_segments);
}
function isPositiveInteger(value) {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}
function parseImportedFrom(raw) {
	if (raw == null) return;
	const record = asRecord$5(raw);
	if (!record || typeof record.record_id !== "string" || typeof record.cwd_original !== "string" || typeof record.exported_by !== "string" || typeof record.exported_at !== "string") return null;
	return {
		recordId: record.record_id,
		cwdOriginal: record.cwd_original,
		exportedBy: record.exported_by,
		exportedAt: record.exported_at
	};
}
function parseSessionRecordMetadata(record) {
	const lastRequestId = normalizeOptionalString(record.last_request_id);
	if (lastRequestId === null) return null;
	const importedFrom = parseImportedFrom(record.imported_from);
	if (importedFrom === null) return null;
	return {
		lastRequestId,
		importedFrom
	};
}
function normalizeOptionalName(value) {
	if (value == null) return;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function normalizeOptionalPid(value) {
	if (value == null) return;
	return isPositiveInteger(value) ? value : null;
}
function normalizeOptionalBoolean(value, fallback = false) {
	if (value == null) return fallback;
	return typeof value === "boolean" ? value : null;
}
function normalizeOptionalString(value) {
	if (value == null) return;
	return typeof value === "string" ? value : null;
}
function normalizeOptionalExitCode(value) {
	if (value === void 0) return;
	if (value === null) return null;
	if (Number.isInteger(value)) return value;
	return Symbol("invalid");
}
function normalizeOptionalSignal(value) {
	if (value === void 0) return;
	if (value === null) return null;
	if (typeof value === "string") return value;
	return Symbol("invalid");
}
function parseSessionRecord(raw) {
	const record = asRecord$5(raw);
	if (!record) return null;
	if (record.schema !== "acpx.session.v1") return null;
	const optionals = validSessionOptionals({
		name: normalizeOptionalName(record.name),
		pid: normalizeOptionalPid(record.pid),
		closed: normalizeOptionalBoolean(record.closed, false),
		closedAt: normalizeOptionalString(record.closed_at),
		agentStartedAt: normalizeOptionalString(record.agent_started_at),
		lastPromptAt: normalizeOptionalString(record.last_prompt_at),
		lastAgentExitCode: normalizeOptionalExitCode(record.last_agent_exit_code),
		lastAgentExitSignal: normalizeOptionalSignal(record.last_agent_exit_signal),
		lastAgentExitAt: normalizeOptionalString(record.last_agent_exit_at),
		lastAgentDisconnectReason: normalizeOptionalString(record.last_agent_disconnect_reason)
	});
	if (!hasValidSessionRecordCore(record) || !optionals) return null;
	const conversation = parseConversationRecord(record);
	if (!conversation) return null;
	const eventLog = parseEventLog(record.event_log, record.acpx_record_id);
	const metadata = parseSessionRecordMetadata(record);
	if (!metadata) return null;
	return {
		schema: SESSION_RECORD_SCHEMA,
		acpxRecordId: record.acpx_record_id,
		acpSessionId: record.acp_session_id,
		agentSessionId: normalizeAgentSessionId(record.agent_session_id),
		agentCommand: record.agent_command,
		agentArgv: parsePersistedAgentArgv(record),
		cwd: record.cwd,
		name: optionals.name,
		createdAt: record.created_at,
		lastUsedAt: record.last_used_at,
		lastSeq: record.last_seq,
		lastRequestId: metadata.lastRequestId,
		eventLog,
		closed: optionals.closed,
		closedAt: optionals.closedAt,
		pid: optionals.pid,
		agentStartedAt: optionals.agentStartedAt,
		lastPromptAt: optionals.lastPromptAt,
		lastAgentExitCode: optionals.lastAgentExitCode,
		lastAgentExitSignal: optionals.lastAgentExitSignal,
		lastAgentExitAt: optionals.lastAgentExitAt,
		lastAgentDisconnectReason: optionals.lastAgentDisconnectReason,
		protocolVersion: typeof record.protocol_version === "number" ? record.protocol_version : void 0,
		agentCapabilities: asRecord$5(record.agent_capabilities),
		title: conversation.title,
		messages: conversation.messages,
		updated_at: conversation.updated_at,
		cumulative_token_usage: conversation.cumulative_token_usage,
		cumulative_cost: conversation.cumulative_cost,
		request_token_usage: conversation.request_token_usage,
		acpx: parseAcpxState(record.acpx),
		importedFrom: metadata.importedFrom
	};
}
function hasValidSessionRecordCore(record) {
	return hasStringFields(record, [
		"acpx_record_id",
		"acp_session_id",
		"agent_command",
		"cwd",
		"created_at",
		"last_used_at"
	]) && typeof record.last_seq === "number" && Number.isInteger(record.last_seq) && record.last_seq >= 0;
}
function validSessionOptionals(options) {
	if (hasNullOptionalSessionFields(options) || hasInvalidExitStatus(options)) return null;
	return options;
}
function hasNullOptionalSessionFields(options) {
	return [
		options.name,
		options.pid,
		options.closed,
		options.closedAt,
		options.agentStartedAt,
		options.lastPromptAt,
		options.lastAgentExitAt,
		options.lastAgentDisconnectReason
	].some((value) => value === null);
}
function hasInvalidExitStatus(options) {
	return typeof options.lastAgentExitCode === "symbol" || typeof options.lastAgentExitSignal === "symbol";
}
//#endregion
//#region src/perf-metrics.ts
const counters = /* @__PURE__ */ new Map();
const gauges = /* @__PURE__ */ new Map();
const timings = /* @__PURE__ */ new Map();
function hrNow() {
	return process.hrtime.bigint();
}
function durationMs(start) {
	return Number(process.hrtime.bigint() - start) / 1e6;
}
function roundMetric(value) {
	return Number(value.toFixed(3));
}
function incrementPerfCounter(name, delta = 1) {
	counters.set(name, (counters.get(name) ?? 0) + delta);
}
function setPerfGauge(name, value) {
	gauges.set(name, value);
}
function recordPerfDuration(name, durationMsValue) {
	const next = timings.get(name) ?? {
		count: 0,
		totalMs: 0,
		maxMs: 0
	};
	next.count += 1;
	next.totalMs += durationMsValue;
	next.maxMs = Math.max(next.maxMs, durationMsValue);
	timings.set(name, next);
}
async function measurePerf(name, run) {
	const startedAt = hrNow();
	try {
		return await run();
	} finally {
		recordPerfDuration(name, durationMs(startedAt));
	}
}
function startPerfTimer(name) {
	const startedAt = hrNow();
	return () => {
		const elapsedMs = durationMs(startedAt);
		recordPerfDuration(name, elapsedMs);
		return elapsedMs;
	};
}
function getPerfMetricsSnapshot() {
	return {
		counters: Object.fromEntries(counters.entries()),
		gauges: Object.fromEntries(gauges.entries()),
		timings: Object.fromEntries([...timings.entries()].map(([name, bucket]) => [name, {
			count: bucket.count,
			totalMs: roundMetric(bucket.totalMs),
			maxMs: roundMetric(bucket.maxMs)
		}]))
	};
}
function resetPerfMetrics() {
	counters.clear();
	gauges.clear();
	timings.clear();
}
function formatPerfMetric(name, durationMsValue) {
	return `${name}=${roundMetric(durationMsValue)}ms`;
}
//#endregion
//#region src/persisted-key-policy.ts
const SNAKE_CASE_KEY = /^[a-z][a-z0-9_]*$/;
const ZED_TAG_KEYS = /* @__PURE__ */ new Set([
	"User",
	"Agent",
	"Resume",
	"Text",
	"Mention",
	"Image",
	"Audio",
	"Thinking",
	"RedactedThinking",
	"ToolUse"
]);
const MAP_OBJECT_PATHS = /* @__PURE__ */ new Set([
	"request_token_usage",
	"messages.Agent.tool_results",
	"acpx.session_options.env",
	"acpx.available_model_names"
]);
const OPAQUE_VALUE_PATHS = /* @__PURE__ */ new Set([
	"agent_capabilities",
	"messages.Agent.content.ToolUse.input",
	"acpx.desired_config_options",
	"acpx.config_options"
]);
function isRecord(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function joinPath(path) {
	return path.join(".");
}
function shouldSkipKeyRule(path) {
	return MAP_OBJECT_PATHS.has(joinPath(path));
}
function shouldSkipDescend(path) {
	return OPAQUE_VALUE_PATHS.has(joinPath(path)) || isToolResultOutputPath(path);
}
function isToolResultOutputTail(path, toolResultsIndex) {
	return toolResultsIndex !== -1 && toolResultsIndex + 2 === path.length - 1;
}
function isToolResultOutputPath(path) {
	if (path.length < 5 || path[path.length - 1] !== "output") return false;
	const toolResultsIndex = path.lastIndexOf("tool_results");
	if (!isToolResultOutputTail(path, toolResultsIndex)) return false;
	return path.slice(0, toolResultsIndex + 1).join(".") === "messages.Agent.tool_results";
}
function collectViolations(value, path, violations) {
	if (Array.isArray(value)) {
		for (const entry of value) collectViolations(entry, path, violations);
		return;
	}
	if (!isRecord(value)) return;
	const skipKeyRule = shouldSkipKeyRule(path);
	for (const [key, child] of Object.entries(value)) collectKeyViolation(child, key, path, skipKeyRule, violations);
}
function collectKeyViolation(child, key, path, skipKeyRule, violations) {
	if (!skipKeyRule && !SNAKE_CASE_KEY.test(key) && !ZED_TAG_KEYS.has(key)) violations.push(`${joinPath(path)}.${key}`.replace(/^\./, ""));
	const childPath = [...path, key];
	if (!shouldSkipDescend(childPath)) collectViolations(child, childPath, violations);
}
function findPersistedKeyPolicyViolations(value) {
	const violations = [];
	collectViolations(value, [], violations);
	return violations;
}
function assertPersistedKeyPolicy(value) {
	const violations = findPersistedKeyPolicyViolations(value);
	if (violations.length === 0) return;
	throw new Error(`Persisted key policy violation (expected snake_case keys): ${violations.join(", ")}`);
}
//#endregion
//#region src/session/persistence/index.ts
const SESSION_INDEX_SCHEMA = "acpx.session-index.v1";
function asRecord$4(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return value;
}
function parseIndexEntry(raw) {
	const record = asRecord$4(raw);
	if (!record) return;
	if (!hasRequiredIndexEntryFields(record)) return;
	if (record.name !== void 0 && typeof record.name !== "string") return;
	return {
		file: record.file,
		acpxRecordId: record.acpxRecordId,
		acpSessionId: record.acpSessionId,
		agentCommand: record.agentCommand,
		cwd: record.cwd,
		name: record.name,
		closed: record.closed,
		lastUsedAt: record.lastUsedAt
	};
}
function hasRequiredIndexEntryFields(record) {
	return [
		"file",
		"acpxRecordId",
		"acpSessionId",
		"agentCommand",
		"cwd",
		"lastUsedAt"
	].every((key) => typeof record[key] === "string") && typeof record.closed === "boolean";
}
function sessionIndexPath(sessionDir) {
	return path.join(sessionDir, "index.json");
}
function toSessionIndexEntry(record, fileName) {
	return {
		file: fileName,
		acpxRecordId: record.acpxRecordId,
		acpSessionId: record.acpSessionId,
		agentCommand: record.agentCommand,
		cwd: record.cwd,
		name: record.name,
		closed: record.closed === true,
		lastUsedAt: record.lastUsedAt
	};
}
async function readSessionIndex(sessionDir) {
	const filePath = sessionIndexPath(sessionDir);
	try {
		const payload = await fs$1.readFile(filePath, "utf8");
		const record = asRecord$4(JSON.parse(payload));
		if (!record || record.schema !== SESSION_INDEX_SCHEMA || !Array.isArray(record.files)) return;
		const files = record.files.filter((entry) => typeof entry === "string");
		if (files.length !== record.files.length || !Array.isArray(record.entries)) return;
		const entries = record.entries.map((entry) => parseIndexEntry(entry)).filter((entry) => Boolean(entry));
		if (entries.length !== record.entries.length) return;
		return {
			schema: SESSION_INDEX_SCHEMA,
			files,
			entries
		};
	} catch {
		return;
	}
}
async function writeSessionIndex(sessionDir, index) {
	await writePrivateJsonFile(sessionIndexPath(sessionDir), {
		schema: SESSION_INDEX_SCHEMA,
		files: index.files.toSorted(),
		entries: index.entries.toSorted((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
	});
}
async function rebuildSessionIndex(sessionDir) {
	const files = await listSessionFiles(sessionDir);
	const indexEntries = [];
	for (const file of files) try {
		const payload = await fs$1.readFile(path.join(sessionDir, file), "utf8");
		const parsed = parseSessionRecord(JSON.parse(payload));
		if (!parsed) continue;
		indexEntries.push(toSessionIndexEntry(parsed, file));
	} catch {}
	const index = {
		schema: SESSION_INDEX_SCHEMA,
		files,
		entries: indexEntries
	};
	await writeSessionIndex(sessionDir, index);
	return index;
}
async function loadOrRebuildSessionIndex(sessionDir) {
	const files = await listSessionFiles(sessionDir);
	const existing = await readSessionIndex(sessionDir);
	if (existing && existing.files.length === files.length && existing.files.every((file, index) => file === files[index])) return existing;
	return await rebuildSessionIndex(sessionDir);
}
async function listSessionFiles(sessionDir) {
	return (await fs$1.readdir(sessionDir, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "index.json").map((entry) => entry.name).toSorted();
}
//#endregion
//#region src/session/persistence/repository.ts
const DEFAULT_HISTORY_LIMIT = 20;
function sessionFilePath(acpxRecordId) {
	const safeId = safeSessionId(acpxRecordId);
	return path.join(sessionBaseDir(), `${safeId}.json`);
}
async function ensureSessionDir() {
	await fs$1.mkdir(sessionBaseDir(), {
		recursive: true,
		mode: 448
	});
}
async function loadRecordFromIndexEntry(entry) {
	try {
		const payload = await fs$1.readFile(path.join(sessionBaseDir(), entry.file), "utf8");
		return parseSessionRecord(JSON.parse(payload)) ?? void 0;
	} catch {
		return;
	}
}
async function loadSessionIndexEntries() {
	await ensureSessionDir();
	return (await measurePerf("session.index_load", async () => {
		return await loadOrRebuildSessionIndex(sessionBaseDir());
	})).entries;
}
function matchesSessionEntry(session, normalizedCwd, normalizedName, includeClosed = false) {
	if (session.cwd !== normalizedCwd) return false;
	if (!includeClosed && session.closed) return false;
	if (normalizedName == null) return session.name == null;
	return session.name === normalizedName;
}
async function writeSessionRecord(record) {
	await measurePerf("session.write_record", async () => {
		const persisted = serializeSessionRecordForDisk(record);
		assertPersistedKeyPolicy(persisted);
		const file = sessionFilePath(record.acpxRecordId);
		await writePrivateJsonFile(file, persisted);
		const sessionDir = sessionBaseDir();
		const index = await loadOrRebuildSessionIndex(sessionDir);
		const fileName = path.basename(file);
		const entries = index.entries.filter((entry) => entry.file !== fileName);
		entries.push(toSessionIndexEntry(record, fileName));
		await writeSessionIndex(sessionDir, {
			files: [.../* @__PURE__ */ new Set([...index.files.filter((entry) => entry !== fileName), fileName])],
			entries
		});
	});
}
async function resolveSessionRecord(sessionId) {
	await ensureSessionDir();
	const directPath = sessionFilePath(sessionId);
	try {
		const directPayload = await measurePerf("session.resolve_direct", async () => {
			return await fs$1.readFile(directPath, "utf8");
		});
		const directRecord = parseSessionRecord(JSON.parse(directPayload));
		if (directRecord) return directRecord;
	} catch {}
	const entries = await loadSessionIndexEntries();
	const exactEntries = entries.filter((entry) => entry.acpxRecordId === sessionId || entry.acpSessionId === sessionId);
	const exactRecords = (await Promise.all(exactEntries.map((entry) => loadRecordFromIndexEntry(entry)))).filter((entry) => Boolean(entry));
	if (exactRecords.length === 1) return exactRecords[0];
	if (exactRecords.length > 1) throw new SessionResolutionError(`Multiple sessions match id: ${sessionId}`);
	const suffixEntries = entries.filter((entry) => entry.acpxRecordId.endsWith(sessionId) || entry.acpSessionId.endsWith(sessionId));
	const suffixRecords = (await Promise.all(suffixEntries.map((entry) => loadRecordFromIndexEntry(entry)))).filter((entry) => Boolean(entry));
	if (suffixRecords.length === 1) return suffixRecords[0];
	if (suffixRecords.length > 1) throw new SessionResolutionError(`Session id is ambiguous: ${sessionId}`);
	incrementPerfCounter("session.resolve_miss");
	throw new SessionNotFoundError(sessionId);
}
function hasGitDirectory(dir) {
	const gitPath = path.join(dir, ".git");
	try {
		return statSync(gitPath).isDirectory();
	} catch {
		return false;
	}
}
function isWithinBoundary(boundary, target) {
	const relative = path.relative(boundary, target);
	return relative.length === 0 || !relative.startsWith("..") && !path.isAbsolute(relative);
}
function absolutePath(value) {
	return path.resolve(value);
}
function findGitRepositoryRoot(startDir) {
	let current = absolutePath(startDir);
	const root = path.parse(current).root;
	for (;;) {
		if (hasGitDirectory(current)) return current;
		if (current === root) return;
		const parent = path.dirname(current);
		if (parent === current) return;
		current = parent;
	}
}
function normalizeName(value) {
	if (value == null) return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function isoNow$1() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
async function listSessions() {
	await ensureSessionDir();
	const entries = await loadSessionIndexEntries();
	const records = [];
	for (const entry of entries) {
		const parsed = await loadRecordFromIndexEntry(entry);
		if (parsed) records.push(parsed);
	}
	records.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
	return records;
}
async function listSessionsForAgent(agentCommand) {
	const entries = (await loadSessionIndexEntries()).filter((session) => session.agentCommand === agentCommand);
	return (await Promise.all(entries.map((entry) => loadRecordFromIndexEntry(entry)))).filter((entry) => Boolean(entry)).toSorted((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}
async function findSession(options) {
	const normalizedCwd = absolutePath(options.cwd);
	const normalizedName = normalizeName(options.name);
	const match = (await loadSessionIndexEntries()).find((session) => session.agentCommand === options.agentCommand && matchesSessionEntry(session, normalizedCwd, normalizedName, options.includeClosed));
	if (!match) return;
	return await loadRecordFromIndexEntry(match);
}
async function findSessionByDirectoryWalk(options) {
	const normalizedName = normalizeName(options.name);
	const normalizedStart = absolutePath(options.cwd);
	const normalizedBoundary = absolutePath(options.boundary ?? normalizedStart);
	const walkBoundary = isWithinBoundary(normalizedBoundary, normalizedStart) ? normalizedBoundary : normalizedStart;
	const sessions = (await loadSessionIndexEntries()).filter((session) => session.agentCommand === options.agentCommand);
	let current = normalizedStart;
	const walkRoot = path.parse(current).root;
	for (;;) {
		const match = sessions.find((session) => matchesSessionEntry(session, current, normalizedName));
		if (match) return await loadRecordFromIndexEntry(match);
		const parent = nextWalkParent(current, walkBoundary, walkRoot);
		if (!parent) return;
		current = parent;
	}
}
function nextWalkParent(current, walkBoundary, walkRoot) {
	if (current === walkBoundary || current === walkRoot) return;
	const parent = path.dirname(current);
	if (parent === current || !isWithinBoundary(walkBoundary, parent)) return;
	return parent;
}
function closedAtOrLastUsedAt(record) {
	return record.closedAt ?? record.lastUsedAt;
}
function isSessionStreamFile(fileName, safeId) {
	return fileName === `${safeId}.stream.ndjson` || fileName === `${safeId}.stream.lock` || fileName.startsWith(`${safeId}.stream.`);
}
async function pruneSessions(options = {}) {
	await ensureSessionDir();
	const records = await loadPrunableRecords(filterPruneCandidates(await loadSessionIndexEntries(), options.agentCommand), options.before ?? (options.olderThanMs != null ? new Date(Date.now() - options.olderThanMs) : void 0));
	if (options.dryRun) return {
		pruned: records,
		bytesFreed: 0,
		dryRun: true
	};
	const sessionDir = sessionBaseDir();
	let bytesFreed = 0;
	let dirEntries = [];
	if (options.includeHistory) try {
		dirEntries = await fs$1.readdir(sessionDir);
	} catch {}
	for (const record of records) bytesFreed += await pruneSessionFiles(record, sessionDir, dirEntries, options.includeHistory === true);
	await rebuildSessionIndex(sessionDir).catch(() => {});
	return {
		pruned: records,
		bytesFreed,
		dryRun: false
	};
}
function filterPruneCandidates(entries, agentCommand) {
	return entries.filter((entry) => entry.closed && (!agentCommand || entry.agentCommand === agentCommand));
}
async function loadPrunableRecords(entries, cutoff) {
	const records = [];
	const cutoffIso = cutoff?.toISOString();
	for (const entry of entries) {
		const record = await loadRecordFromIndexEntry(entry);
		if (record && isBeforeCutoff(record, cutoffIso)) records.push(record);
	}
	return records;
}
function isBeforeCutoff(record, cutoffIso) {
	return !cutoffIso || closedAtOrLastUsedAt(record) < cutoffIso;
}
async function pruneSessionFiles(record, sessionDir, dirEntries, includeHistory) {
	const safeId = safeSessionId(record.acpxRecordId);
	let bytesFreed = await unlinkCountingBytes(path.join(sessionDir, `${safeId}.json`));
	if (includeHistory) for (const name of dirEntries.filter((entry) => isSessionStreamFile(entry, safeId))) bytesFreed += await unlinkCountingBytes(path.join(sessionDir, name));
	return bytesFreed;
}
async function unlinkCountingBytes(filePath) {
	let bytes = 0;
	try {
		bytes = (await fs$1.stat(filePath)).size;
	} catch {}
	await fs$1.unlink(filePath).catch(() => void 0);
	return bytes;
}
//#endregion
//#region src/permission-prompt.ts
async function promptForPermission(options) {
	if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
	if (options.header) process.stderr.write(`\n${options.header}\n`);
	if (options.details && options.details.trim().length > 0) process.stderr.write(`${options.details}\n`);
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stderr
	});
	try {
		const normalized = (await rl.question(options.prompt)).trim().toLowerCase();
		return normalized === "y" || normalized === "yes";
	} finally {
		rl.close();
	}
}
//#endregion
//#region src/filesystem.ts
const WRITE_PREVIEW_MAX_LINES = 16;
const WRITE_PREVIEW_MAX_CHARS = 1200;
function nowIso$1() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
function toWritePreview(content) {
	const lines = content.replace(/\r\n/g, "\n").split("\n");
	const visibleLines = lines.slice(0, WRITE_PREVIEW_MAX_LINES);
	let preview = visibleLines.join("\n");
	if (lines.length > visibleLines.length) preview += `\n... (${lines.length - visibleLines.length} more lines)`;
	if (preview.length > WRITE_PREVIEW_MAX_CHARS) preview = `${preview.slice(0, 1197)}...`;
	return preview;
}
async function defaultConfirmWrite(filePath, preview) {
	return await promptForPermission({
		header: `[permission] Allow write to ${filePath}?`,
		details: preview,
		prompt: "Allow write? (y/N) "
	});
}
function canPromptForPermission$2() {
	return process.stdin.isTTY && process.stderr.isTTY;
}
var FileSystemHandlers = class {
	rootDir;
	workspace;
	permissionMode;
	nonInteractivePermissions;
	onOperation;
	usesDefaultConfirmWrite;
	confirmWrite;
	constructor(options) {
		this.rootDir = path.resolve(options.cwd);
		this.permissionMode = options.permissionMode;
		this.nonInteractivePermissions = options.nonInteractivePermissions ?? "deny";
		this.onOperation = options.onOperation;
		this.usesDefaultConfirmWrite = options.confirmWrite == null;
		this.confirmWrite = options.confirmWrite ?? defaultConfirmWrite;
	}
	updatePermissionPolicy(permissionMode, nonInteractivePermissions) {
		this.permissionMode = permissionMode;
		this.nonInteractivePermissions = nonInteractivePermissions ?? "deny";
	}
	async readTextFile(params) {
		const filePath = this.resolvePathWithinRoot(params.path);
		const summary = `read_text_file: ${filePath}`;
		this.emitOperation({
			method: "fs/read_text_file",
			status: "running",
			summary,
			details: this.readWindowDetails(params.line, params.limit),
			timestamp: nowIso$1()
		});
		try {
			if (this.permissionMode === "deny-all") throw new PermissionDeniedError("Permission denied for fs/read_text_file (--deny-all)");
			const content = await (await this.getWorkspace()).readText(`.${path.sep}${path.relative(this.rootDir, filePath)}`);
			const sliced = this.sliceContent(content, params.line, params.limit);
			this.emitOperation({
				method: "fs/read_text_file",
				status: "completed",
				summary,
				details: this.readWindowDetails(params.line, params.limit),
				timestamp: nowIso$1()
			});
			return { content: sliced };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.emitOperation({
				method: "fs/read_text_file",
				status: "failed",
				summary,
				details: message,
				timestamp: nowIso$1()
			});
			throw error;
		}
	}
	async writeTextFile(params) {
		const filePath = this.resolvePathWithinRoot(params.path);
		const preview = toWritePreview(params.content);
		const summary = `write_text_file: ${filePath}`;
		this.emitOperation({
			method: "fs/write_text_file",
			status: "running",
			summary,
			details: preview,
			timestamp: nowIso$1()
		});
		try {
			if (!await this.isWriteApproved(filePath, preview)) throw new PermissionDeniedError("Permission denied for fs/write_text_file");
			const file = await (await this.getWorkspace()).openWritable(`.${path.sep}${path.relative(this.rootDir, filePath)}`, { mode: 438 });
			try {
				await file.handle.writeFile(params.content, "utf8");
			} finally {
				await file.handle.close();
			}
			this.emitOperation({
				method: "fs/write_text_file",
				status: "completed",
				summary,
				details: preview,
				timestamp: nowIso$1()
			});
			return {};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.emitOperation({
				method: "fs/write_text_file",
				status: "failed",
				summary,
				details: message,
				timestamp: nowIso$1()
			});
			throw error;
		}
	}
	async isWriteApproved(filePath, preview) {
		if (this.permissionMode === "approve-all") return true;
		if (this.permissionMode === "deny-all") return false;
		if (this.usesDefaultConfirmWrite && this.nonInteractivePermissions === "fail" && !canPromptForPermission$2()) throw new PermissionPromptUnavailableError();
		return await this.confirmWrite(filePath, preview);
	}
	resolvePathWithinRoot(rawPath) {
		if (!path.isAbsolute(rawPath)) throw new Error(`Path must be absolute: ${rawPath}`);
		const resolved = path.resolve(rawPath);
		if (!isPathInside(this.rootDir, resolved)) throw new Error(`Path is outside allowed cwd subtree: ${resolved}`);
		return resolved;
	}
	getWorkspace() {
		return this.workspace ??= root(this.rootDir, {
			symlinks: "follow-within-root",
			hardlinks: "allow",
			maxBytes: Infinity
		});
	}
	sliceContent(content, line, limit) {
		if (line == null && limit == null) return content;
		const lines = content.split("\n");
		const startIndex = Math.max(0, (line == null ? 1 : Math.max(1, Math.trunc(line))) - 1);
		const maxLines = limit == null ? void 0 : Math.max(0, Math.trunc(limit));
		if (maxLines === 0) return "";
		const endIndex = maxLines == null ? lines.length : Math.min(lines.length, startIndex + maxLines);
		return lines.slice(startIndex, endIndex).join("\n");
	}
	readWindowDetails(line, limit) {
		if (line == null && limit == null) return;
		return `line=${line == null ? 1 : Math.max(1, Math.trunc(line))}, limit=${limit == null ? "all" : Math.max(0, Math.trunc(limit))}`;
	}
	emitOperation(operation) {
		this.onOperation?.(operation);
	}
};
//#endregion
//#region src/permissions.ts
const PERMISSION_MODE_RANK = {
	"deny-all": 0,
	"approve-reads": 1,
	"approve-all": 2
};
function selected(optionId) {
	return { outcome: {
		outcome: "selected",
		optionId
	} };
}
function cancelled() {
	return { outcome: { outcome: "cancelled" } };
}
function withPermissionMetadata(response, metadata) {
	return {
		...response,
		_meta: {
			...response._meta,
			acpx: {
				...response._meta?.acpx && typeof response._meta.acpx === "object" && !Array.isArray(response._meta.acpx) ? response._meta.acpx : {},
				...metadata
			}
		}
	};
}
function pickOption(options, kinds) {
	for (const kind of kinds) {
		const match = options.find((option) => option.kind === kind);
		if (match) return match;
	}
}
const TOOL_KIND_TITLE_MATCHERS = [
	{
		kind: "read",
		needles: ["read", "cat"]
	},
	{
		kind: "search",
		needles: [
			"search",
			"find",
			"grep"
		]
	},
	{
		kind: "edit",
		needles: [
			"write",
			"edit",
			"patch"
		]
	},
	{
		kind: "delete",
		needles: ["delete", "remove"]
	},
	{
		kind: "move",
		needles: ["move", "rename"]
	},
	{
		kind: "execute",
		needles: [
			"run",
			"execute",
			"bash"
		]
	},
	{
		kind: "fetch",
		needles: [
			"fetch",
			"http",
			"url"
		]
	},
	{
		kind: "think",
		needles: ["think"]
	}
];
function inferToolKind(params) {
	if (params.toolCall.kind) return params.toolCall.kind;
	const title = params.toolCall.title?.trim().toLowerCase();
	if (!title) return;
	const head = title.split(":", 1)[0]?.trim();
	if (!head) return;
	return titleHeadToolKind(head) ?? "other";
}
function titleHeadToolKind(head) {
	return TOOL_KIND_TITLE_MATCHERS.find(({ needles }) => needles.some((needle) => head.includes(needle)))?.kind;
}
function isAutoApprovedReadKind(kind) {
	return kind === "read" || kind === "search";
}
async function promptForToolPermission(params) {
	return await promptForPermission({ prompt: `\n[permission] Allow ${params.toolCall.title ?? "tool"} [${inferToolKind(params) ?? "other"}]? (y/N) ` });
}
function canPromptForPermission$1() {
	return process.stdin.isTTY && process.stderr.isTTY;
}
function readStringProperty(value, keys) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const record = value;
	for (const key of keys) {
		const entry = record[key];
		if (typeof entry === "string" && entry.trim().length > 0) return entry.trim();
	}
}
function readToolName(params) {
	const rawInputName = readStringProperty(params.toolCall.rawInput, [
		"name",
		"tool",
		"toolName"
	]);
	if (rawInputName) return rawInputName;
	const head = (params.toolCall.title?.trim())?.split(/[:\s]/, 1)[0]?.trim();
	return head && head.length > 0 ? head : void 0;
}
function normalizeMatcher(value) {
	return value.trim().toLowerCase();
}
function permissionMatchTokens(params) {
	const tokens = /* @__PURE__ */ new Set();
	const kind = inferToolKind(params);
	const rawKind = params.toolCall.kind;
	const title = params.toolCall.title?.trim();
	const toolName = readToolName(params);
	for (const value of [
		kind,
		rawKind,
		title,
		toolName
	]) if (typeof value === "string" && value.trim().length > 0) tokens.add(normalizeMatcher(value));
	if (title) {
		const head = title.split(/[:\s]/, 1)[0]?.trim();
		if (head) tokens.add(normalizeMatcher(head));
	}
	return [...tokens];
}
function findPolicyRule(rules, params) {
	if (!rules || rules.length === 0) return;
	const tokens = permissionMatchTokens(params);
	for (const rule of rules) {
		const normalized = normalizeMatcher(rule);
		if (normalized === "*" || tokens.includes(normalized)) return rule;
	}
}
function matchPermissionPolicy(params, policy) {
	if (!policy) return;
	const denyRule = findPolicyRule(policy.autoDeny, params);
	if (denyRule) return {
		action: "deny",
		matchedRule: denyRule
	};
	const approveRule = findPolicyRule(policy.autoApprove, params);
	if (approveRule) return {
		action: "approve",
		matchedRule: approveRule
	};
	const escalateRule = findPolicyRule(policy.escalate, params);
	if (escalateRule) return {
		action: "escalate",
		matchedRule: escalateRule
	};
	return policy.defaultAction ? { action: policy.defaultAction } : void 0;
}
function buildEscalationEvent(params, matchedRule) {
	const toolKind = inferToolKind(params);
	const toolTitle = params.toolCall.title?.trim() || "tool";
	const toolName = readToolName(params);
	return {
		type: "permission_escalation",
		sessionId: params.sessionId,
		toolCallId: params.toolCall.toolCallId,
		...toolName ? { toolName } : {},
		toolTitle,
		...params.toolCall.rawInput !== void 0 ? { toolInput: params.toolCall.rawInput } : {},
		...toolKind ? { toolKind } : {},
		action: "escalate",
		...matchedRule ? { matchedRule } : {},
		message: `Permission escalation required for ${toolTitle}`,
		timestamp: (/* @__PURE__ */ new Date()).toISOString()
	};
}
function selectedOrFirst(options, allowOption) {
	return { response: selected((allowOption ?? options[0]).optionId) };
}
function selectedOrCancelled(option) {
	return { response: option ? selected(option.optionId) : cancelled() };
}
async function resolveEscalatingPermissionRequest(params, policyMatch, allowOption, rejectOption) {
	if (canPromptForPermission$1()) return resolveInteractivePromptResult(params, allowOption, rejectOption);
	const escalation = buildEscalationEvent(params, policyMatch.matchedRule);
	return {
		response: withPermissionMetadata(rejectOption ? selected(rejectOption.optionId) : cancelled(), { permissionEscalation: escalation }),
		escalation
	};
}
async function resolveInteractivePromptResult(params, allowOption, rejectOption) {
	const approved = await promptForToolPermission(params);
	if (approved && allowOption) return { response: selected(allowOption.optionId) };
	if (!approved && rejectOption) return { response: selected(rejectOption.optionId) };
	return { response: cancelled() };
}
function resolvePolicyMatch(params, policyMatch, options, allowOption, rejectOption) {
	if (policyMatch?.action === "approve") return selectedOrFirst(options, allowOption);
	if (policyMatch?.action === "deny") return selectedOrCancelled(rejectOption);
	if (policyMatch?.action === "escalate") return resolveEscalatingPermissionRequest(params, policyMatch, allowOption, rejectOption);
}
function resolveModeMatch(options, mode, allowOption, rejectOption) {
	if (mode === "approve-all") return selectedOrFirst(options, allowOption);
	if (mode === "deny-all") return selectedOrCancelled(rejectOption);
}
function resolveNonInteractivePermission(nonInteractivePolicy, rejectOption) {
	if (nonInteractivePolicy === "fail") throw new PermissionPromptUnavailableError();
	return selectedOrCancelled(rejectOption);
}
async function resolveReadOrPromptPermission(params, nonInteractivePolicy, allowOption, rejectOption) {
	if (isAutoApprovedReadKind(inferToolKind(params)) && allowOption) return { response: selected(allowOption.optionId) };
	if (!canPromptForPermission$1()) return resolveNonInteractivePermission(nonInteractivePolicy, rejectOption);
	return resolveInteractivePromptResult(params, allowOption, rejectOption);
}
function permissionModeSatisfies(actual, required) {
	return PERMISSION_MODE_RANK[actual] >= PERMISSION_MODE_RANK[required];
}
async function resolvePermissionRequestWithDetails(params, mode, nonInteractivePolicy = "deny", policy) {
	const options = params.options ?? [];
	if (options.length === 0) return { response: cancelled() };
	const allowOption = pickOption(options, ["allow_once", "allow_always"]);
	const rejectOption = pickOption(options, ["reject_once", "reject_always"]);
	const resolvedByPolicy = await resolvePolicyMatch(params, matchPermissionPolicy(params, policy), options, allowOption, rejectOption);
	if (resolvedByPolicy) return resolvedByPolicy;
	const resolvedByMode = resolveModeMatch(options, mode, allowOption, rejectOption);
	if (resolvedByMode) return resolvedByMode;
	return resolveReadOrPromptPermission(params, nonInteractivePolicy, allowOption, rejectOption);
}
const DECISION_FALLBACK_ORDER = {
	allow_once: ["allow_once", "allow_always"],
	allow_always: ["allow_always", "allow_once"],
	reject_once: ["reject_once", "reject_always"],
	reject_always: ["reject_always", "reject_once"]
};
function decisionToResponse(params, decision) {
	if (decision.outcome === "cancel") return cancelled();
	const matched = pickOption(params.options ?? [], DECISION_FALLBACK_ORDER[decision.outcome]);
	return matched ? selected(matched.optionId) : cancelled();
}
function classifyPermissionDecision(params, response) {
	if (response.outcome.outcome !== "selected") return "cancelled";
	const selectedOptionId = response.outcome.optionId;
	const selectedOption = params.options.find((option) => option.optionId === selectedOptionId);
	if (!selectedOption) return "cancelled";
	if (selectedOption.kind === "allow_once" || selectedOption.kind === "allow_always") return "approved";
	return "denied";
}
//#endregion
//#region src/prompt-content.ts
var PromptInputValidationError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "PromptInputValidationError";
	}
};
function asRecord$3(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return value;
}
function isNonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0;
}
function isBase64Data(value) {
	if (value.length === 0 || value.length % 4 !== 0) return false;
	return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}
function isImageMimeType(value) {
	return /^image\/[A-Za-z0-9.+-]+$/i.test(value);
}
function isAudioMimeType(value) {
	return /^audio\/[A-Za-z0-9.+-]+$/i.test(value);
}
function isTextBlock(value) {
	const record = asRecord$3(value);
	return record?.type === "text" && typeof record.text === "string";
}
function isImageBlock(value) {
	const record = asRecord$3(value);
	return record?.type === "image" && isNonEmptyString(record.mimeType) && isImageMimeType(record.mimeType) && typeof record.data === "string" && isBase64Data(record.data);
}
function isAudioBlock(value) {
	const record = asRecord$3(value);
	return record?.type === "audio" && isNonEmptyString(record.mimeType) && isAudioMimeType(record.mimeType) && typeof record.data === "string" && isBase64Data(record.data);
}
function isResourceLinkBlock(value) {
	const record = asRecord$3(value);
	return record?.type === "resource_link" && isNonEmptyString(record.uri) && (record.title === void 0 || typeof record.title === "string") && (record.name === void 0 || typeof record.name === "string");
}
function isResourcePayload(value) {
	const record = asRecord$3(value);
	if (!record || !isNonEmptyString(record.uri)) return false;
	return record.text === void 0 || typeof record.text === "string";
}
function isResourceBlock(value) {
	const record = asRecord$3(value);
	return record?.type === "resource" && isResourcePayload(record.resource);
}
const CONTENT_BLOCK_VALIDATORS = [
	isTextBlock,
	isImageBlock,
	isAudioBlock,
	isResourceLinkBlock,
	isResourceBlock
];
function isContentBlock(value) {
	return CONTENT_BLOCK_VALIDATORS.some((validator) => validator(value));
}
const CONTENT_BLOCK_ERROR_VALIDATORS = {
	text: validateTextContentBlock,
	image: validateImageContentBlock,
	audio: validateAudioContentBlock,
	resource_link: validateResourceLinkContentBlock,
	resource: validateResourceContentBlock
};
function contentBlockErrorValidator(type) {
	return Object.hasOwn(CONTENT_BLOCK_ERROR_VALIDATORS, type) ? CONTENT_BLOCK_ERROR_VALIDATORS[type] : void 0;
}
function validateTextContentBlock(record, index) {
	return typeof record.text === "string" ? void 0 : `prompt[${index}] text block must include a string text field`;
}
function validateImageContentBlock(record, index) {
	if (!isNonEmptyString(record.mimeType)) return `prompt[${index}] image block must include a non-empty mimeType`;
	if (!isImageMimeType(record.mimeType)) return `prompt[${index}] image block mimeType must start with image/`;
	if (typeof record.data !== "string" || record.data.length === 0) return `prompt[${index}] image block must include non-empty base64 data`;
	return isBase64Data(record.data) ? void 0 : `prompt[${index}] image block data must be valid base64`;
}
function validateAudioContentBlock(record, index) {
	if (!isNonEmptyString(record.mimeType)) return `prompt[${index}] audio block must include a non-empty mimeType`;
	if (!isAudioMimeType(record.mimeType)) return `prompt[${index}] audio block mimeType must start with audio/`;
	if (typeof record.data !== "string" || record.data.length === 0) return `prompt[${index}] audio block must include non-empty base64 data`;
	return isBase64Data(record.data) ? void 0 : `prompt[${index}] audio block data must be valid base64`;
}
function validateResourceLinkContentBlock(record, index) {
	if (!isNonEmptyString(record.uri)) return `prompt[${index}] resource_link block must include a non-empty uri`;
	if (record.title !== void 0 && typeof record.title !== "string") return `prompt[${index}] resource_link block title must be a string when present`;
	if (record.name !== void 0 && typeof record.name !== "string") return `prompt[${index}] resource_link block name must be a string when present`;
}
function validateResourceContentBlock(record, index) {
	if (!asRecord$3(record.resource)) return `prompt[${index}] resource block must include a resource object`;
	return isResourcePayload(record.resource) ? void 0 : `prompt[${index}] resource block resource must include a non-empty uri and optional text`;
}
function getContentBlockValidationError(value, index) {
	const record = asRecord$3(value);
	if (!record || typeof record.type !== "string") return `prompt[${index}] must be an ACP content block object`;
	const validator = contentBlockErrorValidator(record.type);
	return validator ? validator(record, index) : `prompt[${index}] has unsupported content block type ${JSON.stringify(record.type)}`;
}
function isPromptInput(value) {
	return Array.isArray(value) && value.every((entry) => isContentBlock(entry));
}
function promptCapabilityRequirement(block) {
	switch (block.type) {
		case "image": return {
			blockType: "image",
			capability: "image"
		};
		case "audio": return {
			blockType: "audio",
			capability: "audio"
		};
		case "resource": return {
			blockType: "resource",
			capability: "embeddedContext"
		};
		default: return;
	}
}
function getUnsupportedPromptContentMessage(prompt, agentCapabilities) {
	for (const [index, block] of prompt.entries()) {
		const requirement = promptCapabilityRequirement(block);
		if (!requirement) continue;
		if (agentCapabilities?.promptCapabilities?.[requirement.capability] === true) continue;
		return `prompt[${index}] ${requirement.blockType} content requires agentCapabilities.promptCapabilities.${requirement.capability}`;
	}
}
function textPrompt(text) {
	return [{
		type: "text",
		text
	}];
}
function parseStructuredPrompt(source) {
	if (!source.startsWith("[")) return;
	try {
		const parsed = JSON.parse(source);
		if (isPromptInput(parsed)) return parsed;
		if (Array.isArray(parsed)) throw new PromptInputValidationError(parsed.map((entry, index) => getContentBlockValidationError(entry, index)).find((message) => message !== void 0) ?? "Structured prompt JSON must be an array of valid ACP content blocks");
		return;
	} catch (error) {
		if (error instanceof PromptInputValidationError) throw error;
		return;
	}
}
function parsePromptSource(source) {
	const trimmed = source.trim();
	const structured = parseStructuredPrompt(trimmed);
	if (structured) return structured;
	if (!trimmed) return [];
	return textPrompt(trimmed);
}
function mergePromptSourceWithText(source, suffixText) {
	const prompt = parsePromptSource(source);
	const appended = suffixText.trim();
	if (!appended) return prompt;
	if (prompt.length === 0) return textPrompt(appended);
	return [...prompt, ...textPrompt(appended)];
}
function promptToDisplayText(prompt) {
	return prompt.map((block) => contentBlockDisplayText(block)).filter((entry) => entry.trim().length > 0).join("\n\n").trim();
}
function contentBlockDisplayText(block) {
	switch (block.type) {
		case "text": return block.text;
		case "resource_link": return block.title ?? block.name ?? block.uri;
		case "resource": return resourceBlockDisplayText(block);
		case "image": return `[image] ${block.mimeType}`;
		case "audio": return `[audio] ${block.mimeType}`;
		default: return "";
	}
}
function resourceBlockDisplayText(block) {
	return "text" in block.resource && typeof block.resource.text === "string" ? block.resource.text : block.resource.uri;
}
//#endregion
//#region src/acp/agent-command.ts
const DEFAULT_AGENT_CLOSE_AFTER_STDIN_END_MS = 100;
const QODER_AGENT_CLOSE_AFTER_STDIN_END_MS = 750;
const GEMINI_ACP_STARTUP_TIMEOUT_MS = 15e3;
const CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS = 6e4;
const GEMINI_VERSION_TIMEOUT_MS = 2e3;
const GEMINI_ACP_FLAG_VERSION = [
	0,
	33,
	0
];
const COPILOT_HELP_TIMEOUT_MS = 2e3;
const CLAUDE_CODE_DEFAULT_SETTING_SOURCES = ["project", "local"];
const QODER_BENIGN_STDOUT_LINES = /* @__PURE__ */ new Set(["Received interrupt signal. Cleaning up resources...", "Cleanup completed. Exiting..."]);
function resolveAgentCloseAfterStdinEndMs(agentCommand) {
	const { command } = splitCommandLine(agentCommand);
	return basenameToken(command) === "qodercli" ? QODER_AGENT_CLOSE_AFTER_STDIN_END_MS : DEFAULT_AGENT_CLOSE_AFTER_STDIN_END_MS;
}
function shouldIgnoreNonJsonAgentOutputLine(agentCommand, trimmedLine) {
	const { command } = splitCommandLine(agentCommand);
	return basenameToken(command) === "qodercli" && QODER_BENIGN_STDOUT_LINES.has(trimmedLine);
}
function isGeminiAcpCommand(command, args) {
	return basenameToken(command) === "gemini" && (args.includes("--acp") || args.includes("--experimental-acp"));
}
function isClaudeAcpCommand(command, args) {
	if (basenameToken(command) === "claude-agent-acp") return true;
	return args.some((arg) => arg.includes("claude-agent-acp"));
}
function isCopilotAcpCommand(command, args) {
	return basenameToken(command) === "copilot" && args.includes("--acp");
}
function isQoderAcpCommand(command, args) {
	return basenameToken(command) === "qodercli" && args.includes("--acp");
}
function isCursorAcpCommand(command, args) {
	const commandToken = basenameToken(command);
	return commandToken === "cursor-agent" || commandToken === "agent" && args.includes("acp");
}
function isDevinAcpCommand(command, args) {
	return basenameToken(command) === "devin" && (args.includes("acp") || args.includes("--acp") || args.includes("--experimental-acp"));
}
function hasCommandFlag(args, flagName) {
	return args.some((arg) => arg === flagName || arg.startsWith(`${flagName}=`));
}
function normalizeQoderAllowedToolName(tool) {
	switch (tool.trim().toLowerCase()) {
		case "bash":
		case "glob":
		case "grep":
		case "ls":
		case "read":
		case "write": return tool.trim().toUpperCase();
		default: return tool.trim();
	}
}
function buildQoderAcpCommandArgs(initialArgs, options) {
	const args = [...initialArgs];
	const sessionOptions = options.sessionOptions;
	if (typeof sessionOptions?.maxTurns === "number" && !hasCommandFlag(args, "--max-turns")) args.push(`--max-turns=${sessionOptions.maxTurns}`);
	if (Array.isArray(sessionOptions?.allowedTools) && !hasCommandFlag(args, "--allowed-tools") && !hasCommandFlag(args, "--disallowed-tools")) {
		const encodedTools = sessionOptions.allowedTools.map(normalizeQoderAllowedToolName).join(",");
		args.push(`--allowed-tools=${encodedTools}`);
	}
	return args;
}
function resolveGeminiAcpStartupTimeoutMs() {
	const raw = process.env.ACPX_GEMINI_ACP_STARTUP_TIMEOUT_MS;
	if (typeof raw === "string" && raw.trim().length > 0) {
		const parsed = Number(raw);
		if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
	}
	return GEMINI_ACP_STARTUP_TIMEOUT_MS;
}
function resolveClaudeAcpSessionCreateTimeoutMs() {
	const raw = process.env.ACPX_CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS;
	if (typeof raw === "string" && raw.trim().length > 0) {
		const parsed = Number(raw);
		if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
	}
	return CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS;
}
function parseGeminiVersion(value) {
	if (typeof value !== "string") return;
	const normalized = value.trim();
	const match = normalized.match(/(\d+)\.(\d+)\.(\d+)/);
	if (!match) return;
	return {
		raw: normalized,
		parts: [
			Number(match[1]),
			Number(match[2]),
			Number(match[3])
		]
	};
}
function compareVersionParts(left, right) {
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const leftPart = left[index] ?? 0;
		const rightPart = right[index] ?? 0;
		if (leftPart !== rightPart) return leftPart - rightPart;
	}
	return 0;
}
async function detectGeminiVersion(command) {
	const versionLine = (await readCommandOutput(command, ["--version"], GEMINI_VERSION_TIMEOUT_MS))?.split(/\r?\n/).map((line) => line.trim()).find((line) => /\d+\.\d+\.\d+/.test(line));
	return parseGeminiVersion(versionLine);
}
async function resolveGeminiCommandArgs(command, args) {
	if (basenameToken(command) !== "gemini" || !args.includes("--acp")) return [...args];
	const version = await detectGeminiVersion(command);
	if (version && compareVersionParts(version.parts, GEMINI_ACP_FLAG_VERSION) < 0) return args.map((arg) => arg === "--acp" ? "--experimental-acp" : arg);
	return [...args];
}
async function readCommandOutput(command, args, timeoutMs) {
	return await new Promise((resolve) => {
		const child = spawn(command, [...args], buildSpawnCommandOptions(command, {
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			windowsHide: true
		}));
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.removeAllListeners();
			child.stdout?.removeAllListeners();
			child.stderr?.removeAllListeners();
			resolve(value);
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(void 0);
		}, timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", () => {
			finish(void 0);
		});
		child.once("close", () => {
			finish(`${stdout}\n${stderr}`);
		});
	});
}
async function buildGeminiAcpStartupTimeoutMessage(command) {
	const parts = ["Gemini CLI ACP startup timed out before initialize completed.", "This usually means the local Gemini CLI is waiting on interactive OAuth or has incompatible ACP subprocess behavior."];
	const version = await detectGeminiVersion(command);
	if (version) parts.push(`Detected Gemini CLI version: ${version.raw}.`);
	if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) parts.push("No GEMINI_API_KEY or GOOGLE_API_KEY was set for non-interactive auth.");
	parts.push("Try upgrading Gemini CLI and using API-key-based auth for non-interactive ACP runs.");
	return parts.join(" ");
}
function buildClaudeAcpSessionCreateTimeoutMessage() {
	return [
		"Claude ACP session creation timed out before session/new completed.",
		"This matches the known persistent-session stall seen with some Claude Code and @agentclientprotocol/claude-agent-acp combinations.",
		"In harnessed or non-interactive runs, prefer --approve-all with nonInteractivePermissions=deny, upgrade Claude Code and the Claude ACP adapter, or use acpx claude exec as a one-shot fallback."
	].join(" ");
}
async function buildCopilotAcpUnsupportedMessage(command) {
	const parts = ["GitHub Copilot CLI ACP stdio mode is not available in the installed copilot binary.", "acpx copilot expects a Copilot CLI release that supports --acp --stdio."];
	const helpOutput = await readCommandOutput(command, ["--help"], COPILOT_HELP_TIMEOUT_MS);
	if (typeof helpOutput === "string" && !helpOutput.includes("--acp")) parts.push("Detected copilot --help output without --acp support.");
	parts.push("Upgrade GitHub Copilot CLI to a release with ACP stdio support, or use --agent with another ACP-compatible adapter in the meantime.");
	return parts.join(" ");
}
async function ensureCopilotAcpSupport(command) {
	const helpOutput = await readCommandOutput(command, ["--help"], COPILOT_HELP_TIMEOUT_MS);
	if (typeof helpOutput === "string" && !helpOutput.includes("--acp")) throw new CopilotAcpUnsupportedError(await buildCopilotAcpUnsupportedMessage(command), { retryable: false });
}
function buildClaudeCodeOptionsMeta(options, isolateUserSettings = false) {
	const claudeCodeOptions = {};
	if (isolateUserSettings) claudeCodeOptions.settingSources = resolveClaudeCodeSettingSources();
	if (options) assignClaudeCodeOptions(claudeCodeOptions, options);
	const meta = {};
	if (Object.keys(claudeCodeOptions).length > 0) meta.claudeCode = { options: claudeCodeOptions };
	assignClaudeCodeSystemPrompt(meta, options?.systemPrompt);
	if (Object.keys(meta).length === 0) return;
	return meta;
}
function resolveClaudeCodeSettingSources(env = process.env) {
	if (env.ACPX_CLAUDE_INCLUDE_USER_SETTINGS?.trim() === "1") return ["user", ...CLAUDE_CODE_DEFAULT_SETTING_SOURCES];
	return [...CLAUDE_CODE_DEFAULT_SETTING_SOURCES];
}
function assignClaudeCodeOptions(target, options) {
	if (typeof options.model === "string" && options.model.trim().length > 0) target.model = options.model;
	if (Array.isArray(options.allowedTools)) target.allowedTools = [...options.allowedTools];
	if (typeof options.maxTurns === "number") target.maxTurns = options.maxTurns;
}
function assignClaudeCodeSystemPrompt(target, systemPrompt) {
	if (typeof systemPrompt === "string" && systemPrompt.length > 0) {
		target.systemPrompt = systemPrompt;
		return;
	}
	if (isAppendSystemPrompt(systemPrompt)) target.systemPrompt = { append: systemPrompt.append };
}
function isAppendSystemPrompt(value) {
	return !!value && typeof value === "object" && typeof value.append === "string" && value.append.length > 0;
}
function resolveClaudeCodeExecutable(platform = process.platform, env = process.env) {
	if (platform !== "win32") return;
	if (readWindowsEnvValue(env, "CLAUDE_CODE_EXECUTABLE")) return;
	return resolveWindowsExecutablePath("claude", env);
}
//#endregion
//#region src/acp/auth-env.ts
const AUTH_ENV_PREFIX = "ACPX_AUTH_";
function toEnvToken(value) {
	return value.trim().replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}
function buildAuthEnvKey(methodId) {
	const token = toEnvToken(methodId);
	return token.length > 0 ? `${AUTH_ENV_PREFIX}${token}` : void 0;
}
const authEnvKeyCache = /* @__PURE__ */ new Map();
function authEnvKey(methodId) {
	const cached = authEnvKeyCache.get(methodId);
	if (cached !== void 0) return cached;
	const key = buildAuthEnvKey(methodId);
	authEnvKeyCache.set(methodId, key);
	return key;
}
function readEnvCredential(methodId) {
	const key = authEnvKey(methodId);
	if (!key) return;
	const value = process.env[key];
	if (typeof value === "string" && value.trim().length > 0) return value;
}
function protectedEnvKey(key) {
	return process.platform === "win32" ? key.toUpperCase() : key;
}
function isAuthEnvKey(key) {
	return protectedEnvKey(key).startsWith(AUTH_ENV_PREFIX);
}
function authEnvSuffix(key) {
	return key.slice(10);
}
function protectEnvKey(protectedKeys, key) {
	protectedKeys.add(protectedEnvKey(key));
}
function promotePrefixedAuthEnvironment(env) {
	const protectedKeys = /* @__PURE__ */ new Set();
	for (const [key, value] of Object.entries(env)) {
		if (!isAuthEnvKey(key)) continue;
		if (typeof value !== "string" || value.trim().length === 0) continue;
		const normalized = toEnvToken(authEnvSuffix(key));
		if (!normalized) continue;
		protectEnvKey(protectedKeys, key);
		protectEnvKey(protectedKeys, normalized);
		if (env[normalized] == null) env[normalized] = value;
	}
	return protectedKeys;
}
function validateAgentProcessEnv(agentProcessEnv) {
	for (const [key, value] of Object.entries(agentProcessEnv ?? {})) if (typeof value !== "string" || key.includes("=") || key.includes("\0") || value.includes("\0")) throw new Error("Invalid agentProcessEnv: environment entries cannot contain NUL or names with '='");
}
function buildAgentEnvironment(authCredentials, sessionEnv, agentProcessEnv) {
	validateAgentProcessEnv(agentProcessEnv);
	const env = { ...process.env };
	const protectedAuthEnvKeys = promotePrefixedAuthEnvironment(env);
	if (authCredentials) for (const [methodId, credential] of Object.entries(authCredentials)) {
		addAuthCredentialEnvKeys(protectedAuthEnvKeys, methodId, credential);
		assignAuthCredentialEnv(env, methodId, credential);
	}
	for (const overlay of [sessionEnv, agentProcessEnv]) for (const [key, value] of Object.entries(overlay ?? {})) {
		if (typeof value !== "string" || protectedAuthEnvKeys.has(protectedEnvKey(key))) continue;
		assignSessionEnv(env, key, value);
	}
	return env;
}
function assignSessionEnv(env, key, value) {
	const normalizedKey = protectedEnvKey(key);
	for (const existingKey of Object.keys(env)) if (protectedEnvKey(existingKey) === normalizedKey) delete env[existingKey];
	env[key] = value;
}
function addAuthCredentialEnvKeys(protectedKeys, methodId, credential) {
	if (typeof credential !== "string" || credential.trim().length === 0) return;
	if (!methodId.includes("=") && !methodId.includes("\0")) protectEnvKey(protectedKeys, methodId);
	const normalized = toEnvToken(methodId);
	if (normalized) {
		protectEnvKey(protectedKeys, `${AUTH_ENV_PREFIX}${normalized}`);
		protectEnvKey(protectedKeys, normalized);
	}
}
function assignAuthCredentialEnv(env, methodId, credential) {
	if (typeof credential !== "string" || credential.trim().length === 0) return;
	if (!methodId.includes("=") && !methodId.includes("\0") && env[methodId] == null) env[methodId] = credential;
	const normalized = toEnvToken(methodId);
	if (normalized) {
		assignIfMissing(env, `${AUTH_ENV_PREFIX}${normalized}`, credential);
		assignIfMissing(env, normalized, credential);
	}
}
function assignIfMissing(env, key, value) {
	if (env[key] == null) env[key] = value;
}
function resolveConfiguredAuthCredential(methodId, authCredentials) {
	const configCredentials = authCredentials ?? {};
	return configCredentials[methodId] ?? configCredentials[toEnvToken(methodId)];
}
function buildAgentSpawnOptions(cwd, authCredentials, sessionEnv, agentProcessEnv) {
	return {
		cwd,
		env: buildAgentEnvironment(authCredentials, sessionEnv, agentProcessEnv),
		stdio: [
			"pipe",
			"pipe",
			"pipe"
		],
		windowsHide: true
	};
}
//#endregion
//#region src/version.ts
const UNKNOWN_VERSION = "0.0.0-unknown";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
let cachedVersion = null;
function parseVersion(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}
function readPackageVersion(packageJsonPath) {
	try {
		return parseVersion(JSON.parse(readFileSync(packageJsonPath, "utf8")).version);
	} catch {
		return null;
	}
}
function resolveVersionFromAncestors(startDir) {
	let current = startDir;
	while (true) {
		const packageVersion = readPackageVersion(path.join(current, "package.json"));
		if (packageVersion) return packageVersion;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}
function resolveAcpxVersion(params) {
	const envVersion = resolvePackageEnvVersion(params?.env ?? process.env);
	if (envVersion) return envVersion;
	if (params?.packageJsonPath) return readPackageVersion(params.packageJsonPath) ?? UNKNOWN_VERSION;
	return resolveVersionFromAncestors(MODULE_DIR) ?? UNKNOWN_VERSION;
}
function resolvePackageEnvVersion(env) {
	const envPackageName = parseVersion(env.npm_package_name);
	const envVersion = parseVersion(env.npm_package_version);
	return envPackageName === "acpx" ? envVersion : null;
}
function getAcpxVersion() {
	if (cachedVersion) return cachedVersion;
	cachedVersion = resolveAcpxVersion();
	return cachedVersion;
}
//#endregion
//#region src/acp/client-protocol.ts
const DEVIN_COMPATIBILITY_CLIENT_CAPABILITIES_META = Object.freeze({ "cognition.ai/requestDiagnostics": true });
const DEVIN_COMPATIBILITY_CLIENT_NAME = "windsurf";
const DEFAULT_DEVIN_COMPATIBILITY_CLIENT_VERSION = "1.110.1";
function resolveClientInfo(devinAcp) {
	if (!devinAcp) return {
		name: "acpx",
		version: getAcpxVersion()
	};
	return {
		name: DEVIN_COMPATIBILITY_CLIENT_NAME,
		version: process.env.ACPX_DEVIN_WINDSURF_VERSION ?? DEFAULT_DEVIN_COMPATIBILITY_CLIENT_VERSION
	};
}
function resolveClientCapabilities(params) {
	const baseCapabilities = {
		fs: {
			readTextFile: params.fs,
			writeTextFile: params.fs
		},
		terminal: params.terminal,
		...params.elicitationModes.length > 0 ? { elicitation: {
			...params.elicitationModes.includes("form") ? { form: {} } : {},
			...params.elicitationModes.includes("url") ? { url: {} } : {}
		} } : {}
	};
	if (!params.devinAcp) return baseCapabilities;
	return {
		...baseCapabilities,
		_meta: DEVIN_COMPATIBILITY_CLIENT_CAPABILITIES_META
	};
}
//#endregion
//#region src/acp/model-support.ts
const REQUESTED_MODEL_UNSUPPORTED_ERROR_CODE = "ACP_MODEL_UNSUPPORTED";
const REQUESTED_MODEL_UNSUPPORTED_REASONS = ["missing-capability", "unadvertised-model"];
var RequestedModelUnsupportedError = class extends Error {
	code = REQUESTED_MODEL_UNSUPPORTED_ERROR_CODE;
	reason;
	constructor(message, reason) {
		super(message);
		this.name = "RequestedModelUnsupportedError";
		this.reason = reason;
	}
};
function isRequestedModelUnsupportedReason(value) {
	return typeof value === "string" && REQUESTED_MODEL_UNSUPPORTED_REASONS.includes(value);
}
function isRequestedModelUnsupportedError(value) {
	if (value instanceof RequestedModelUnsupportedError) return true;
	if (!value || typeof value !== "object") return false;
	const candidate = value;
	return candidate.name === "RequestedModelUnsupportedError" && candidate.code === "ACP_MODEL_UNSUPPORTED" && isRequestedModelUnsupportedReason(candidate.reason);
}
function supportsLegacyClaudeCodeModelMetadata(agentCommand) {
	if (!agentCommand) return false;
	const { command, args } = splitCommandLine(agentCommand);
	return isClaudeAcpCommand(command, args);
}
function asRecord$2(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return value;
}
function parseAvailableModel(value) {
	const option = asRecord$2(value);
	if (!option || typeof option.value !== "string" || typeof option.name !== "string") return;
	return {
		modelId: option.value,
		name: option.name
	};
}
function parseAvailableModelGroup(value) {
	const group = asRecord$2(value);
	if (!group || typeof group.group !== "string" || typeof group.name !== "string" || !Array.isArray(group.options)) return;
	const models = group.options.map((option) => parseAvailableModel(option));
	return models.every((model) => model !== void 0) ? models : void 0;
}
function parseAvailableModels(value) {
	if (!Array.isArray(value)) return;
	const directModels = value.map((option) => parseAvailableModel(option));
	if (directModels.every((model) => model !== void 0)) return directModels;
	const groupedModels = value.map((group) => parseAvailableModelGroup(group));
	return groupedModels.every((models) => models !== void 0) ? groupedModels.flat() : void 0;
}
function isModelSelectOption(option) {
	return option.type === "select" && (option.category === "model" || option.id === "model");
}
function parseModelConfigOption(option) {
	if (!isModelSelectOption(option) || typeof option.id !== "string" || typeof option.currentValue !== "string") return;
	const availableModels = parseAvailableModels(option.options);
	return availableModels ? {
		configId: option.id,
		currentModelId: option.currentValue,
		availableModels
	} : void 0;
}
function modelConfigPriority(option) {
	if (option.category !== "model") return 0;
	return option.id === "model" ? 2 : 1;
}
function modelStateFromConfigOptions(configOptions) {
	if (!Array.isArray(configOptions)) return;
	let selected;
	let selectedPriority = -1;
	for (const value of configOptions) {
		const option = asRecord$2(value);
		if (!option) continue;
		const models = parseModelConfigOption(option);
		if (!models) continue;
		const priority = modelConfigPriority(option);
		if (priority > selectedPriority) {
			selected = models;
			selectedPriority = priority;
		}
	}
	return selected;
}
function modelStateFromLegacyResponse(response) {
	if (!response || typeof response !== "object") return;
	const models = response.models;
	if (!models || typeof models.currentModelId !== "string" || !Array.isArray(models.availableModels)) return;
	const availableModels = models.availableModels.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const candidate = entry;
		return typeof candidate.modelId === "string" && typeof candidate.name === "string" ? [{
			modelId: candidate.modelId,
			name: candidate.name
		}] : [];
	});
	return {
		currentModelId: models.currentModelId,
		availableModels
	};
}
function modelStateFromSessionResponse(params) {
	return modelStateFromConfigOptions(params.configOptions) ?? modelStateFromLegacyResponse(params.response);
}
function formatAvailableModelIds(models) {
	const ids = models?.availableModels.map((model) => model.modelId.trim()).filter((modelId) => modelId.length > 0) ?? [];
	return ids.length > 0 ? ids.join(", ") : "none advertised";
}
function resolveRequestedModelId(params) {
	if (!params.models || !isCursorAcpCommandForModelAlias(params.agentCommand)) return params.requestedModel;
	if (params.models.availableModels.some((model) => model.modelId === params.requestedModel)) return params.requestedModel;
	const candidates = params.models.availableModels.map((model) => model.modelId).filter((modelId) => modelId.startsWith(`${params.requestedModel}[`));
	return candidates.length === 1 ? candidates[0] : params.requestedModel;
}
function isCursorAcpCommandForModelAlias(agentCommand) {
	if (!agentCommand) return false;
	const { command, args } = splitCommandLine(agentCommand);
	return isCursorAcpCommand(command, args);
}
function assertRequestedModelSupported(params) {
	if (!params.models) {
		if (supportsLegacyClaudeCodeModelMetadata(params.agentCommand)) return;
		throw new RequestedModelUnsupportedError(`Cannot ${params.context === "replay" ? "replay saved model" : "apply --model"} "${params.requestedModel}": the ACP agent did not advertise model support through a session config option or legacy models metadata, and the adapter does not support a startup model flag.`, "missing-capability");
	}
	if (!new Set(params.models.availableModels.map((model) => model.modelId)).has(params.requestedModel)) {
		const resolvedModel = resolveRequestedModelId(params);
		if (resolvedModel !== params.requestedModel) return `Cursor ACP advertised "${resolvedModel}" for requested model "${params.requestedModel}"; using the advertised id.`;
		if (supportsLegacyClaudeCodeModelMetadata(params.agentCommand)) return `requested model "${params.requestedModel}" was not in the Claude ACP advertised model list (${formatAvailableModelIds(params.models)}); forwarding it to Claude Code so the adapter can accept or reject it.`;
		throw new RequestedModelUnsupportedError(`Cannot ${params.context === "replay" ? "replay saved model" : "apply --model"} "${params.requestedModel}": the ACP agent did not advertise that model. Available models: ${formatAvailableModelIds(params.models)}.`, "unadvertised-model");
	}
}
//#endregion
//#region src/acp/ndjson-stream.ts
const DEFAULT_MAX_ACP_MESSAGE_BYTES = 67108864;
var AcpMessageLimitError = class extends AcpxOperationalError {
	constructor(limit) {
		super(`ACP message exceeded ACPX_MAX_ACP_MESSAGE_BYTES (${limit} bytes). Increase the limit or set it to 0 for unlimited input.`, {
			outputCode: "RUNTIME",
			detailCode: "ACP_MESSAGE_TOO_LARGE",
			origin: "acp",
			retryable: false
		});
	}
};
function readMaxAcpMessageBytes(raw = process.env.ACPX_MAX_ACP_MESSAGE_BYTES) {
	const value = raw?.trim();
	if (!value) return DEFAULT_MAX_ACP_MESSAGE_BYTES;
	const bytes = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(bytes)) throw new Error("ACPX_MAX_ACP_MESSAGE_BYTES must be a non-negative safe integer; zero is unlimited");
	return bytes === 0 ? void 0 : bytes;
}
function countLineBytes(chunk, retained, limit) {
	let start = 0;
	while (start < chunk.length) {
		const newline = chunk.indexOf(10, start);
		const end = newline < 0 ? chunk.length : newline;
		retained += end - start;
		if (retained > limit) throw new AcpMessageLimitError(limit);
		if (newline < 0) return retained;
		retained = 0;
		start = end + 1;
	}
	return retained;
}
function parseAcpJsonMessageLine(line) {
	const message = JSON.parse(line);
	return isAcpMessageObject(message) ? message : void 0;
}
function enqueueNdJsonLine(agentCommand, line, controller) {
	const trimmedLine = line.trim();
	if (!trimmedLine || shouldIgnoreNonJsonAgentOutputLine(agentCommand, trimmedLine)) return;
	try {
		const message = parseAcpJsonMessageLine(trimmedLine);
		if (message) controller.enqueue(message);
	} catch (err) {
		console.error("Failed to parse JSON message:", trimmedLine, err);
	}
}
function enqueueNdJsonLines(agentCommand, lines, controller) {
	for (const line of lines) enqueueNdJsonLine(agentCommand, line, controller);
}
function createNdJsonMessageStream(agentCommand, output, input, maxMessageBytes, onReadError) {
	const textEncoder = new TextEncoder();
	const textDecoder = new TextDecoder();
	return {
		readable: new ReadableStream({ async start(controller) {
			let content = "";
			let retainedBytes = 0;
			const reader = input.getReader();
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					if (maxMessageBytes !== void 0) retainedBytes = countLineBytes(value, retainedBytes, maxMessageBytes);
					content += textDecoder.decode(value, { stream: true });
					const lines = content.split("\n");
					content = lines.pop() || "";
					enqueueNdJsonLines(agentCommand, lines, controller);
				}
				controller.close();
			} catch (err) {
				const error = err instanceof Error ? err : new Error(String(err));
				controller.error(error);
				onReadError?.(error);
			} finally {
				reader.releaseLock();
			}
		} }),
		writable: new WritableStream({ async write(message) {
			const content = JSON.stringify(message) + "\n";
			const writer = output.getWriter();
			try {
				await writer.write(textEncoder.encode(content));
			} finally {
				writer.releaseLock();
			}
		} })
	};
}
//#endregion
//#region src/acp/observed-stream.ts
function observeAcpStream(base, options) {
	const elicitationRequestIds = /* @__PURE__ */ new Set();
	const shouldSuppressInboundReplaySessionUpdate = (message) => {
		return options.suppressReplaySessionUpdates() && isSessionUpdateNotification(message);
	};
	const observeInbound = (message) => {
		const requestId = elicitationRequestId(message);
		if (requestId !== void 0) {
			elicitationRequestIds.add(requestId);
			return;
		}
		if (!shouldSuppressInboundReplaySessionUpdate(message)) options.onMessage("inbound", message);
	};
	return {
		readable: new ReadableStream({ async start(controller) {
			const reader = base.readable.getReader();
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					if (!value) continue;
					observeInbound(value);
					if (isExtensionNotification(value)) continue;
					controller.enqueue(value);
				}
			} finally {
				reader.releaseLock();
				controller.close();
			}
		} }),
		writable: new WritableStream({ async write(message) {
			const promptOwner = promptRequestOwner(message);
			const activePrompt = promptOwner ? options.bindPromptOwner(promptOwner) : void 0;
			const id = responseId(message);
			if (!(id !== void 0 && elicitationRequestIds.delete(id))) options.onMessage("outbound", message);
			const writer = base.writable.getWriter();
			try {
				await writer.write(message);
			} finally {
				writer.releaseLock();
			}
			if (activePrompt && promptOwner) options.onPromptRequestWritten(activePrompt, promptOwner);
		} })
	};
}
function isExtensionNotification(message) {
	if (!("method" in message) || "id" in message || typeof message.method !== "string") return false;
	return message.method !== methods.client.session.update && message.method !== methods.client.elicitation.complete && message.method !== methods.protocol.cancelRequest;
}
function elicitationRequestId(message) {
	if (!("method" in message) || message.method !== methods.client.elicitation.create || !("id" in message)) return;
	return message.id;
}
function responseId(message) {
	if (!("id" in message) || "method" in message) return;
	return message.id;
}
function promptRequestOwner(message) {
	if (!("method" in message) || message.method !== methods.agent.session.prompt || !("id" in message)) return;
	const sessionId = message.params?.sessionId;
	return typeof sessionId === "string" ? {
		requestId: message.id,
		sessionId
	} : void 0;
}
//#endregion
//#region src/acp/process-descendants.ts
function parseProcessTable(output) {
	const table = /* @__PURE__ */ new Map();
	for (const line of output.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
		if (match && !match[3].startsWith("Z")) {
			const pid = Number(match[1]);
			if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) table.set(pid, {
				pid,
				parentPid: Number(match[2]),
				birth: match[4]
			});
		}
	}
	return table;
}
function includeDescendants(table, owned) {
	let expanded;
	do {
		expanded = false;
		for (const identity of table.values()) if (owned.has(identity.parentPid) && !owned.has(identity.pid)) {
			owned.add(identity.pid);
			expanded = true;
		}
	} while (expanded);
}
/** Best-effort POSIX cleanup for descendants witnessed during this child launch. */
var ProcessDescendants = class {
	child;
	identities = /* @__PURE__ */ new Map();
	pending;
	retired = false;
	constructor(child) {
		this.child = child;
	}
	capture(timeoutMs = PROCESS_HELPER_TIMEOUT_MS) {
		if (this.retired || process.platform === "win32") return Promise.resolve(true);
		this.pending ??= this.readSnapshot(timeoutMs).finally(() => {
			this.pending = void 0;
		});
		return this.pending;
	}
	async readSnapshot(timeoutMs) {
		try {
			const output = await runTimedExecFile("ps", ["-eo", "pid=,ppid=,stat=,lstart="], { timeoutMs });
			if (!this.retired) this.refresh(parseProcessTable(output));
			return true;
		} catch {
			return false;
		}
	}
	refresh(table) {
		const owned = /* @__PURE__ */ new Set();
		for (const [pid, identity] of this.identities) if (table.get(pid)?.birth === identity.birth) owned.add(pid);
		const root = this.child.pid;
		if (root && isChildProcessRunning(this.child)) owned.add(root);
		includeDescendants(table, owned);
		owned.delete(root ?? 0);
		this.identities = new Map([...table].filter(([pid]) => owned.has(pid)));
	}
	async signal(signal, timeoutMs) {
		if (!await this.capture(timeoutMs) || this.retired) return;
		for (const pid of this.identities.keys()) try {
			process.kill(pid, signal);
		} catch {
			this.identities.delete(pid);
		}
	}
	async waitForExit(timeoutMs) {
		const deadline = Date.now() + timeoutMs;
		do {
			if (!await this.capture(Math.max(1, deadline - Date.now()))) return false;
			if (this.identities.size === 0) return true;
			await setTimeout$1(Math.min(100, Math.max(0, deadline - Date.now())));
		} while (Date.now() < deadline);
		return false;
	}
	retire() {
		this.retired = true;
		this.identities.clear();
	}
};
//#endregion
//#region src/acp/session-control-errors.ts
const SESSION_CONTROL_UNSUPPORTED_ACP_CODES = /* @__PURE__ */ new Set([-32601, -32602]);
function asRecord$1(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return value;
}
function isLikelySessionControlUnsupportedError(acp) {
	if (SESSION_CONTROL_UNSUPPORTED_ACP_CODES.has(acp.code)) return true;
	if (acp.code !== -32603) return false;
	const details = asRecord$1(acp.data)?.details;
	return typeof details === "string" && details.toLowerCase().includes("invalid params");
}
function formatSessionControlAcpSummary(acp) {
	const details = asRecord$1(acp.data)?.details;
	if (typeof details === "string" && details.trim().length > 0) return `${details.trim()} (ACP ${acp.code}, adapter reported "${acp.message}")`;
	return `${acp.message} (ACP ${acp.code})`;
}
function maybeWrapSessionControlError(method, error, context) {
	const acp = extractAcpError(error);
	if (!acp || !isLikelySessionControlUnsupportedError(acp)) return error;
	const acpSummary = formatSessionControlAcpSummary(acp);
	const message = `Agent rejected ${method}${context ? ` ${context}` : ""}: ${acpSummary}. The adapter may not implement ${method}, or the requested value is not supported.`;
	const wrapped = new Error(message, { cause: error instanceof Error ? error : void 0 });
	wrapped.acp = acp;
	return wrapped;
}
//#endregion
//#region src/acp/terminal-manager.ts
const DEFAULT_TERMINAL_OUTPUT_LIMIT_BYTES = 65536;
const DEFAULT_KILL_GRACE_MS = 1500;
function nowIso() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
function toCommandLine(command, args) {
	const renderedArgs = (args ?? []).map((arg) => JSON.stringify(arg)).join(" ");
	return renderedArgs.length > 0 ? `${command} ${renderedArgs}` : command;
}
function toEnvObject(env) {
	if (!env || env.length === 0) return;
	const merged = { ...process.env };
	for (const entry of env) merged[entry.name] = entry.value;
	return merged;
}
function buildTerminalSpawnOptions(command, cwd, env, platform = process.platform) {
	const resolvedEnv = toEnvObject(env);
	return buildSpawnCommandOptions(command, {
		cwd,
		env: resolvedEnv,
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		],
		windowsHide: true
	}, platform, resolvedEnv ?? process.env);
}
function readTerminalOutputCeiling() {
	const raw = process.env.ACPX_TERMINAL_MAX_OUTPUT_BYTES?.trim();
	if (!raw) return;
	const bytes = Number(raw);
	if (!/^\d+$/.test(raw) || !Number.isSafeInteger(bytes)) throw new Error("ACPX_TERMINAL_MAX_OUTPUT_BYTES must be a non-negative safe integer; zero disables the host ceiling");
	return bytes === 0 ? void 0 : bytes;
}
function trimToUtf8Boundary(buffer, limit) {
	if (limit <= 0) return Buffer.alloc(0);
	if (buffer.length <= limit) return buffer;
	let start = buffer.length - limit;
	while (start < buffer.length && (buffer[start] & 192) === 128) start += 1;
	if (start >= buffer.length) start = buffer.length - limit;
	return buffer.subarray(start);
}
async function defaultConfirmExecute(commandLine) {
	return await promptForPermission({ prompt: `\n[permission] Allow terminal command "${commandLine}"? (y/N) ` });
}
function canPromptForPermission() {
	return process.stdin.isTTY && process.stderr.isTTY;
}
function waitMs(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, Math.max(0, ms));
	});
}
function onStreamError() {}
var TerminalManager = class {
	cwd;
	permissionMode;
	nonInteractivePermissions;
	onOperation;
	usesDefaultConfirmExecute;
	confirmExecute;
	killGraceMs;
	processHelperTimeoutMs;
	outputCeilingBytes;
	terminals = /* @__PURE__ */ new Map();
	constructor(options) {
		this.outputCeilingBytes = readTerminalOutputCeiling();
		this.cwd = options.cwd;
		this.permissionMode = options.permissionMode;
		this.nonInteractivePermissions = options.nonInteractivePermissions ?? "deny";
		this.onOperation = options.onOperation;
		this.usesDefaultConfirmExecute = options.confirmExecute == null;
		this.confirmExecute = options.confirmExecute ?? defaultConfirmExecute;
		this.killGraceMs = Math.max(0, Math.round(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS));
		this.processHelperTimeoutMs = Math.max(1, Math.round(options.processHelperTimeoutMs ?? 8e3));
	}
	updatePermissionPolicy(permissionMode, nonInteractivePermissions) {
		this.permissionMode = permissionMode;
		this.nonInteractivePermissions = nonInteractivePermissions ?? "deny";
	}
	async createTerminal(params) {
		const commandLine = toCommandLine(params.command, params.args);
		const summary = `terminal/create: ${commandLine}`;
		this.emitOperation({
			method: "terminal/create",
			status: "running",
			summary,
			timestamp: nowIso()
		});
		try {
			if (!await this.isExecuteApproved(commandLine)) throw new PermissionDeniedError("Permission denied for terminal/create");
			const requestedLimit = Math.max(0, Math.round(params.outputByteLimit ?? DEFAULT_TERMINAL_OUTPUT_LIMIT_BYTES));
			const outputByteLimit = Math.min(requestedLimit, this.outputCeilingBytes ?? Number.POSITIVE_INFINITY);
			const { proc, spawnCommand } = await spawnTerminalProcess(params, this.cwd);
			let resolveExit = () => {};
			const exitPromise = new Promise((resolve) => {
				resolveExit = resolve;
			});
			const terminal = {
				process: proc,
				killProcessGroup: spawnCommand.killProcessGroup,
				descendantPids: /* @__PURE__ */ new Set(),
				processHelperTimeoutMs: this.processHelperTimeoutMs,
				output: Buffer.alloc(0),
				truncated: false,
				outputByteLimit,
				exitCode: void 0,
				signal: void 0,
				exitPromise,
				resolveExit
			};
			const appendOutput = (chunk) => {
				const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				if (bytes.length === 0) return;
				terminal.output = Buffer.concat([terminal.output, bytes]);
				if (terminal.output.length > terminal.outputByteLimit) {
					terminal.output = trimToUtf8Boundary(terminal.output, terminal.outputByteLimit);
					terminal.truncated = true;
				}
			};
			proc.stdout.on("data", appendOutput);
			proc.stderr.on("data", appendOutput);
			proc.stdout.on("error", onStreamError);
			proc.stderr.on("error", onStreamError);
			proc.once("exit", (exitCode, signal) => {
				terminal.exitCode = exitCode;
				terminal.signal = signal;
				terminal.processGroupSnapshotPromise = rememberProcessGroupPids(terminal);
				(async () => {
					await terminal.processGroupSnapshotPromise;
					terminal.resolveExit({
						exitCode: exitCode ?? null,
						signal: signal ?? null
					});
				})();
			});
			const terminalId = randomUUID();
			this.terminals.set(terminalId, terminal);
			this.emitOperation({
				method: "terminal/create",
				status: "completed",
				summary,
				details: `terminalId=${terminalId}`,
				timestamp: nowIso()
			});
			return { terminalId };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.emitOperation({
				method: "terminal/create",
				status: "failed",
				summary,
				details: message,
				timestamp: nowIso()
			});
			throw error;
		}
	}
	async terminalOutput(params) {
		const terminal = this.getTerminal(params.terminalId);
		if (!terminal) throw new Error(`Unknown terminal: ${params.terminalId}`);
		const hasExitStatus = terminal.exitCode !== void 0 || terminal.signal !== void 0;
		this.emitOperation({
			method: "terminal/output",
			status: "completed",
			summary: `terminal/output: ${params.terminalId}`,
			timestamp: nowIso()
		});
		return {
			output: terminal.output.toString("utf8"),
			truncated: terminal.truncated,
			exitStatus: hasExitStatus ? {
				exitCode: terminal.exitCode ?? null,
				signal: terminal.signal ?? null
			} : void 0
		};
	}
	async waitForTerminalExit(params) {
		const terminal = this.getTerminal(params.terminalId);
		if (!terminal) throw new Error(`Unknown terminal: ${params.terminalId}`);
		const response = await terminal.exitPromise;
		this.emitOperation({
			method: "terminal/wait_for_exit",
			status: "completed",
			summary: `terminal/wait_for_exit: ${params.terminalId}`,
			details: `exitCode=${response.exitCode ?? "null"}, signal=${response.signal ?? "null"}`,
			timestamp: nowIso()
		});
		return response;
	}
	async killTerminal(params) {
		const terminal = this.getTerminal(params.terminalId);
		if (!terminal) throw new Error(`Unknown terminal: ${params.terminalId}`);
		const summary = `terminal/kill: ${params.terminalId}`;
		this.emitOperation({
			method: "terminal/kill",
			status: "running",
			summary,
			timestamp: nowIso()
		});
		try {
			await this.killProcess(terminal);
			this.emitOperation({
				method: "terminal/kill",
				status: "completed",
				summary,
				timestamp: nowIso()
			});
			return {};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.emitOperation({
				method: "terminal/kill",
				status: "failed",
				summary,
				details: message,
				timestamp: nowIso()
			});
			throw error;
		}
	}
	async releaseTerminal(params) {
		const summary = `terminal/release: ${params.terminalId}`;
		this.emitOperation({
			method: "terminal/release",
			status: "running",
			summary,
			timestamp: nowIso()
		});
		const terminal = this.getTerminal(params.terminalId);
		if (!terminal) {
			this.emitOperation({
				method: "terminal/release",
				status: "completed",
				summary,
				details: "already released",
				timestamp: nowIso()
			});
			return {};
		}
		try {
			await this.killProcess(terminal);
			await terminal.exitPromise.catch(() => {});
			terminal.output = Buffer.alloc(0);
			this.terminals.delete(params.terminalId);
			this.emitOperation({
				method: "terminal/release",
				status: "completed",
				summary,
				timestamp: nowIso()
			});
			return {};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.emitOperation({
				method: "terminal/release",
				status: "failed",
				summary,
				details: message,
				timestamp: nowIso()
			});
			throw error;
		}
	}
	async shutdown() {
		for (const terminalId of Array.from(this.terminals.keys())) await this.releaseTerminal({
			terminalId,
			sessionId: "shutdown"
		});
	}
	getTerminal(terminalId) {
		return this.terminals.get(terminalId);
	}
	emitOperation(operation) {
		this.onOperation?.(operation);
	}
	async isExecuteApproved(commandLine) {
		if (this.permissionMode === "approve-all") return true;
		if (this.permissionMode === "deny-all") return false;
		if (this.usesDefaultConfirmExecute && this.nonInteractivePermissions === "fail" && !canPromptForPermission()) throw new PermissionPromptUnavailableError();
		return await this.confirmExecute(commandLine);
	}
	isRunning(terminal) {
		return terminal.exitCode === void 0 && terminal.signal === void 0;
	}
	async killProcess(terminal) {
		if (!this.isRunning(terminal) && !terminal.killProcessGroup) return;
		try {
			await this.signalProcess(terminal, "SIGTERM");
		} catch {
			return;
		}
		if (await this.waitForCleanupAfterSignal(terminal) && !terminal.killProcessGroup) return;
		try {
			await this.signalProcess(terminal, "SIGKILL");
		} catch {
			return;
		}
		await this.waitForFinalCleanup(terminal);
	}
	async signalProcess(terminal, signal) {
		const pid = terminal.process.pid;
		if (terminal.killProcessGroup && pid && process.platform === "win32") {
			await this.signalWindowsProcessGroup(terminal, pid, signal);
			return;
		}
		if (terminal.killProcessGroup && pid) {
			await this.signalPosixProcessGroup(terminal, pid, signal);
			return;
		}
		terminal.process.kill(signal);
	}
	async signalWindowsProcessGroup(terminal, pid, signal) {
		await this.captureDescendantPids(terminal, pid);
		if (this.isRunning(terminal)) {
			await killWindowsProcessTree(pid, signal, terminal.processHelperTimeoutMs);
			return;
		}
		for (const descendantPid of terminal.descendantPids) await killWindowsProcessTree(descendantPid, signal, terminal.processHelperTimeoutMs);
	}
	async signalPosixProcessGroup(terminal, pid, signal) {
		await this.captureDescendantPids(terminal, pid);
		if (hasLiveProcessGroup(pid)) {
			sendSignal(-pid, signal);
			return;
		}
		for (const descendantPid of terminal.descendantPids) sendSignal(descendantPid, signal);
	}
	async captureDescendantPids(terminal, pid) {
		if (!this.isRunning(terminal)) await terminal.processGroupSnapshotPromise?.catch(() => {});
		for (const descendantPid of await listDescendantPids(pid, terminal.processHelperTimeoutMs)) terminal.descendantPids.add(descendantPid);
	}
	async waitForFinalCleanup(terminal) {
		if (!await this.waitForCleanupAfterSignal(terminal) && process.platform === "win32") throw new Error("Terminal process cleanup did not finish after SIGKILL");
	}
	async waitForCleanupAfterSignal(terminal) {
		return await Promise.race([this.waitForTerminalAndTrackedDescendants(terminal).then(() => true), waitMs(this.killGraceMs).then(() => false)]);
	}
	async waitForTerminalAndTrackedDescendants(terminal) {
		await terminal.exitPromise;
		while (hasLiveTerminalProcessGroup(terminal)) await waitMs(25);
		while (hasLivePid(terminal.descendantPids)) await waitMs(25);
	}
};
async function spawnTerminalProcess(params, defaultCwd) {
	const directCommand = buildTerminalSpawnCommand(params.command, params.args);
	try {
		return {
			proc: await spawnAndWait(directCommand, params, defaultCwd),
			spawnCommand: directCommand
		};
	} catch (error) {
		const fallbackCommand = params.args === void 0 && isNotFoundSpawnError(error) ? buildTerminalFallbackSpawnCommand(params.command, params.cwd ?? defaultCwd) : void 0;
		if (!fallbackCommand) throw error;
		return {
			proc: await spawnAndWait(fallbackCommand, params, defaultCwd),
			spawnCommand: fallbackCommand
		};
	}
}
async function spawnAndWait(spawnCommand, params, defaultCwd) {
	const spawnOptions = buildTerminalSpawnOptions(spawnCommand.command, params.cwd ?? defaultCwd, params.env);
	if (spawnCommand.killProcessGroup) spawnOptions.detached = true;
	const proc = spawn(spawnCommand.command, spawnCommand.args, spawnOptions);
	await waitForSpawn(proc);
	return proc;
}
function isNotFoundSpawnError(error) {
	return error instanceof Error && error.code === "ENOENT";
}
function buildTerminalFallbackSpawnCommand(command, cwd, platform = process.platform) {
	if (commandPathExists(command, cwd)) return;
	if (platform === "win32") return hasWindowsShellSyntax(command) || /\s/u.test(command) ? buildTerminalShellSpawnCommand(command, platform) : void 0;
	if (hasShellSyntax(command) || /\s/u.test(command)) return buildTerminalShellSpawnCommand(command, platform);
}
function hasShellSyntax(command) {
	return /[|&;<>()>$`*?[\]{}'"\\\r\n]/u.test(command);
}
function hasWindowsShellSyntax(command) {
	return /[|&;<>()>$`*?[\]{}'"\r\n]/u.test(command);
}
function commandPathExists(command, cwd) {
	if (!/[\\/]/u.test(command)) return false;
	const resolvedPath = path.isAbsolute(command) ? command : path.resolve(cwd, command);
	return fs.existsSync(resolvedPath);
}
async function listDescendantPids(rootPid, timeoutMs) {
	let output;
	try {
		output = await runProcessListCommand(timeoutMs);
	} catch {
		return [];
	}
	const childrenByParent = /* @__PURE__ */ new Map();
	for (const line of output.split("\n")) addProcessListLine(childrenByParent, line);
	const descendants = [];
	const queue = [...childrenByParent.get(rootPid) ?? []];
	for (let index = 0; index < queue.length; index += 1) {
		const pid = queue[index];
		descendants.push(pid);
		queue.push(...childrenByParent.get(pid) ?? []);
	}
	return descendants;
}
function addProcessListLine(childrenByParent, line) {
	const parsed = parseProcessListLine(line);
	if (!parsed) return;
	const children = childrenByParent.get(parsed.parentPid);
	if (children) children.push(parsed.pid);
	else childrenByParent.set(parsed.parentPid, [parsed.pid]);
}
function parseProcessListLine(line) {
	const match = line.trim().match(/^(\d+)\s+(\d+)$/);
	if (!match) return;
	const pid = Number(match[1]);
	const parentPid = Number(match[2]);
	if (!Number.isInteger(pid) || !Number.isInteger(parentPid) || pid <= 0 || parentPid <= 0) return;
	return {
		pid,
		parentPid
	};
}
async function runProcessListCommand(timeoutMs) {
	if (process.platform === "win32") return await runWindowsProcessListCommand(timeoutMs);
	return await runTimedExecFile("ps", ["-eo", "pid=,ppid="], { timeoutMs });
}
async function rememberProcessGroupPids(terminal) {
	const processGroupId = terminal.process.pid;
	if (!terminal.killProcessGroup || !processGroupId) return;
	if (process.platform === "win32") {
		for (const pid of await listDescendantPids(processGroupId, terminal.processHelperTimeoutMs)) terminal.descendantPids.add(pid);
		return;
	}
	for (const pid of await listProcessGroupPids(processGroupId, terminal.processHelperTimeoutMs)) if (pid !== processGroupId) terminal.descendantPids.add(pid);
}
async function listProcessGroupPids(processGroupId, timeoutMs) {
	let output;
	try {
		output = await runProcessGroupListCommand(timeoutMs);
	} catch {
		return [];
	}
	const pids = [];
	for (const line of output.split("\n")) {
		const match = line.trim().match(/^(\d+)\s+(\d+)$/);
		if (!match) continue;
		const pid = Number(match[1]);
		const pgid = Number(match[2]);
		if (Number.isInteger(pid) && Number.isInteger(pgid) && pid > 0 && pgid === processGroupId) pids.push(pid);
	}
	return pids;
}
async function runProcessGroupListCommand(timeoutMs) {
	return await runTimedExecFile("ps", ["-eo", "pid=,pgid="], { timeoutMs });
}
async function runWindowsProcessListCommand(timeoutMs) {
	const command = ["Get-CimInstance Win32_Process |", "ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"].join(" ");
	return await runTimedExecFile("powershell.exe", [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		command
	], {
		timeoutMs,
		windowsHide: true
	});
}
async function killWindowsProcessTree(pid, signal, timeoutMs = PROCESS_HELPER_TIMEOUT_MS) {
	const args = [
		"/pid",
		String(pid),
		"/t"
	];
	if (signal === "SIGKILL") args.push("/f");
	try {
		await runTimedExecFile("taskkill", args, {
			timeoutMs,
			windowsHide: true
		});
	} catch {}
}
function sendSignal(pid, signal) {
	try {
		process.kill(pid, signal);
	} catch {}
}
function hasLiveProcessGroup(processGroupId) {
	try {
		process.kill(-processGroupId, 0);
		return true;
	} catch {
		return false;
	}
}
function hasLiveTerminalProcessGroup(terminal) {
	const pid = terminal.process.pid;
	return Boolean(terminal.killProcessGroup && pid && process.platform !== "win32" && hasLiveProcessGroup(pid));
}
function hasLivePid(pids) {
	for (const pid of pids) try {
		process.kill(pid, 0);
		return true;
	} catch {
		pids.delete(pid);
	}
	return false;
}
//#endregion
//#region src/acp/client.ts
const REPLAY_IDLE_MS = 80;
const REPLAY_DRAIN_TIMEOUT_MS = 5e3;
const DRAIN_POLL_INTERVAL_MS = 20;
const AGENT_CLOSE_TERM_GRACE_MS = 1500;
const AGENT_CLOSE_KILL_GRACE_MS = 1e3;
const AGENT_CLEANUP_BUDGET_MS = 8e3;
const STARTUP_STDERR_MAX_CHARS = 8192;
const ELICITATION_CANCEL_MESSAGES = {
	inactive: "elicitation owner is no longer active",
	unavailable: "elicitation handler is unavailable",
	unsupported: "elicitation mode is not supported",
	mismatchedSession: "elicitation session is not active",
	cancelled: "elicitation request was cancelled",
	requestScoped: "request-scoped elicitation has no owner"
};
function normalizeElicitationModes(modes) {
	return [...new Set((modes ?? []).filter((mode) => mode === "form" || mode === "url"))];
}
function cancelledElicitationResponse(message) {
	return {
		action: "cancel",
		_meta: { message }
	};
}
function isKnownElicitationResponse(response) {
	if (!response || typeof response !== "object") return false;
	const action = response.action;
	return action === "accept" || action === "decline" || action === "cancel";
}
function elicitationSessionId(request) {
	const value = request.sessionId;
	return typeof value === "string" ? value : void 0;
}
function elicitationRequestScopeId(request) {
	const value = request.requestId;
	return value === null || typeof value === "string" || typeof value === "number" ? value : void 0;
}
async function raceWithAbort(signal, pending) {
	let onAbort;
	const aborted = new Promise((resolve) => {
		onAbort = () => resolve(void 0);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([pending, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
function hasResponseField(response, field) {
	return !!response && typeof response === "object" && field in response;
}
function normalizeResponseConfigOptions(response) {
	if (!response || !("configOptions" in response)) return;
	return response.configOptions ?? [];
}
function toReconnectedSessionResult(response) {
	const configOptions = normalizeResponseConfigOptions(response);
	return {
		agentSessionId: extractAgentSessionId(response?._meta),
		configOptions,
		models: modelStateFromSessionResponse({
			configOptions,
			response
		}),
		configOptionsPresent: hasResponseField(response, "configOptions"),
		legacyModelMetadataPresent: hasResponseField(response, "models")
	};
}
function snapshotPermissionPolicy(policy) {
	if (!policy) return;
	return {
		...policy.autoApprove ? { autoApprove: [...policy.autoApprove] } : {},
		...policy.autoDeny ? { autoDeny: [...policy.autoDeny] } : {},
		...policy.escalate ? { escalate: [...policy.escalate] } : {},
		...policy.defaultAction ? { defaultAction: policy.defaultAction } : {}
	};
}
function snapshotProcessLaunchScope(scope) {
	if (!scope || scope.kind === "client") return Object.freeze({ kind: "client" });
	if (scope.kind === "runtime-session") return Object.freeze({
		kind: "runtime-session",
		sessionKey: scope.sessionKey
	});
	return Object.freeze({
		kind: "runtime-probe",
		agent: scope.agent
	});
}
function childProcessIsRunning(agent) {
	if (!agent) return false;
	return agent.exitCode == null && agent.signalCode == null && !agent.killed;
}
function cancelledPermissionResponse() {
	return { outcome: { outcome: "cancelled" } };
}
function shouldSuppressSdkConsoleError(args) {
	if (args.length === 0) return false;
	return typeof args[0] === "string" && args[0] === "Error handling request";
}
function installSdkConsoleErrorSuppression() {
	const originalConsoleError = console.error;
	console.error = (...args) => {
		if (shouldSuppressSdkConsoleError(args)) return;
		originalConsoleError(...args);
	};
	return () => {
		console.error = originalConsoleError;
	};
}
var AcpClient = class {
	options;
	connection;
	agent;
	agentDescendants = /* @__PURE__ */ new WeakMap();
	agentCleanups = /* @__PURE__ */ new WeakMap();
	initResult;
	loadedSessionId;
	eventHandlers;
	permissionStats = {
		requested: 0,
		approved: 0,
		denied: 0,
		cancelled: 0
	};
	filesystem;
	terminalManager;
	sessionUpdateChain = Promise.resolve();
	observedSessionUpdates = 0;
	processedSessionUpdates = 0;
	suppressSessionUpdates = false;
	suppressReplaySessionUpdateMessages = false;
	activePrompt;
	pendingPromptOwners = [];
	cancellingSessionIds = /* @__PURE__ */ new Set();
	permissionAbortControllers = /* @__PURE__ */ new Map();
	closing = false;
	agentStartedAt;
	lastAgentExit;
	lastKnownPid;
	promptPermissionFailures = /* @__PURE__ */ new Map();
	pendingConnectionRequests = /* @__PURE__ */ new Set();
	modelConfigIds = /* @__PURE__ */ new Map();
	legacyModelSessionIds = /* @__PURE__ */ new Set();
	constructor(options) {
		this.options = {
			...options,
			cwd: asAbsoluteCwd(options.cwd),
			agentProcessEnv: options.agentProcessEnv ? { ...options.agentProcessEnv } : void 0,
			authPolicy: options.authPolicy ?? "skip",
			permissionPolicy: snapshotPermissionPolicy(options.permissionPolicy),
			elicitationModes: normalizeElicitationModes(options.elicitationModes)
		};
		this.eventHandlers = {
			onAcpMessage: this.options.onAcpMessage,
			onAcpOutputMessage: this.options.onAcpOutputMessage,
			onSessionUpdate: this.options.onSessionUpdate,
			onClientOperation: this.options.onClientOperation,
			onPermissionEscalation: this.options.onPermissionEscalation
		};
		this.filesystem = new FileSystemHandlers({
			cwd: this.options.cwd,
			permissionMode: this.options.permissionMode,
			nonInteractivePermissions: this.options.nonInteractivePermissions,
			onOperation: (operation) => {
				this.eventHandlers.onClientOperation?.(operation);
			}
		});
		this.terminalManager = new TerminalManager({
			cwd: this.options.cwd,
			permissionMode: this.options.permissionMode,
			nonInteractivePermissions: this.options.nonInteractivePermissions,
			onOperation: (operation) => {
				this.eventHandlers.onClientOperation?.(operation);
			}
		});
	}
	get initializeResult() {
		return this.initResult;
	}
	getAgentPid() {
		return this.agent?.pid ?? this.lastKnownPid;
	}
	getPermissionStats() {
		return { ...this.permissionStats };
	}
	getAgentLifecycleSnapshot() {
		const pid = this.agent?.pid ?? this.lastKnownPid;
		const running = childProcessIsRunning(this.agent);
		return {
			pid,
			startedAt: this.agentStartedAt,
			running,
			lastExit: this.lastAgentExit ? { ...this.lastAgentExit } : void 0
		};
	}
	supportsLoadSession() {
		return Boolean(this.initResult?.agentCapabilities?.loadSession);
	}
	supportsResumeSession() {
		return Boolean(this.initResult?.agentCapabilities?.sessionCapabilities?.resume);
	}
	supportsCloseSession() {
		return Boolean(this.initResult?.agentCapabilities?.sessionCapabilities?.close);
	}
	supportsListSessions() {
		return Boolean(this.initResult?.agentCapabilities?.sessionCapabilities?.list);
	}
	setEventHandlers(handlers) {
		this.eventHandlers = { ...handlers };
	}
	clearEventHandlers() {
		this.eventHandlers = {};
	}
	updateRuntimeOptions(options) {
		const shouldRefreshPermissionPolicy = options.permissionMode !== void 0 || options.nonInteractivePermissions !== void 0;
		if (options.permissionMode) this.options.permissionMode = options.permissionMode;
		if (options.nonInteractivePermissions !== void 0) this.options.nonInteractivePermissions = options.nonInteractivePermissions;
		if (Object.prototype.hasOwnProperty.call(options, "permissionPolicy")) this.options.permissionPolicy = snapshotPermissionPolicy(options.permissionPolicy);
		this.updateClientCapabilityPreferences(options);
		this.refreshRuntimePermissionPolicy(shouldRefreshPermissionPolicy);
		if (options.suppressSdkConsoleErrors !== void 0) this.options.suppressSdkConsoleErrors = options.suppressSdkConsoleErrors;
		if (options.verbose !== void 0) this.options.verbose = options.verbose;
	}
	updateClientCapabilityPreferences(options) {
		if (options.fs !== void 0) this.options.fs = options.fs;
		if (options.terminal !== void 0) this.options.terminal = options.terminal;
	}
	refreshRuntimePermissionPolicy(enabled) {
		if (!enabled) return;
		this.filesystem.updatePermissionPolicy(this.options.permissionMode, this.options.nonInteractivePermissions);
		this.terminalManager.updatePermissionPolicy(this.options.permissionMode, this.options.nonInteractivePermissions);
	}
	hasReusableSession(sessionId) {
		return this.connection != null && this.agent != null && isChildProcessRunning(this.agent) && this.loadedSessionId === sessionId;
	}
	hasActivePrompt(sessionId) {
		if (!this.activePrompt) return false;
		if (sessionId == null) return true;
		return this.activePrompt.sessionId === sessionId;
	}
	hasUnresolvedPrompt() {
		return this.activePrompt !== void 0;
	}
	endPromptElicitation(sessionId) {
		const active = this.activePrompt;
		if (!active || active.sessionId !== sessionId) return;
		active.elicitationHandler = void 0;
		active.elicitationController.abort();
	}
	async start() {
		if (this.connection && this.agent && isChildProcessRunning(this.agent)) return;
		if (this.connection || this.agent) await this.close();
		const maxMessageBytes = readMaxAcpMessageBytes();
		const launch = await this.resolveAgentLaunchPlan();
		this.logAgentLaunch(launch);
		await this.ensureLaunchSupport(launch);
		const { child, process: startedProcess } = await this.spawnAgentProcess(launch);
		this.agent = child;
		this.closing = false;
		this.agentStartedAt = startedProcess.startedAt;
		this.lastAgentExit = void 0;
		this.lastKnownPid = startedProcess.pid;
		const startupStderr = [];
		child.stderr.on("data", (chunk) => {
			this.captureStartupStderr(startupStderr, chunk);
			if (!this.options.verbose) return;
			process.stderr.write(chunk);
		});
		const startupFailure = this.createStartupFailureWatcher(child, startupStderr);
		try {
			await this.admitAndObserveSpawnedProcess(child, startedProcess);
			const admissionExit = startupFailure.getError();
			if (admissionExit) throw admissionExit;
		} catch (error) {
			startupFailure.dispose();
			throw error;
		}
		const input = Writable.toWeb(child.stdin);
		const output = Readable.toWeb(child.stdout);
		let connection;
		const stream = this.createTappedStream(createNdJsonMessageStream(this.options.agentCommand, input, output, maxMessageBytes, (error) => {
			this.rejectPendingConnectionRequests(error);
			connection?.close(error);
		}));
		connection = this.createConnection(stream, launch);
		connection.signal.addEventListener("abort", () => {
			this.recordAgentExit(child, "connection_close", child.exitCode ?? null, child.signalCode ?? null);
		}, { once: true });
		await this.initializeAgentConnection({
			child,
			connection,
			startupFailure,
			startupStderr,
			launch
		});
	}
	async resolveAgentLaunchPlan() {
		const configuredCommand = resolveAgentCommandParts(this.options.agentCommand, this.options.agentArgv);
		const resolvedBuiltInLaunch = resolveBuiltInAgentLaunch(this.options.agentCommand);
		const spawnCommand = resolvedBuiltInLaunch?.command ?? configuredCommand.command;
		let args = resolvedBuiltInLaunch?.args ?? configuredCommand.args;
		args = await resolveGeminiCommandArgs(spawnCommand, args);
		if (isQoderAcpCommand(spawnCommand, args)) args = buildQoderAcpCommandArgs(args, this.options);
		return {
			spawnCommand,
			args,
			resolvedBuiltInLaunch,
			devinAcp: isDevinAcpCommand(spawnCommand, args),
			geminiAcp: isGeminiAcpCommand(spawnCommand, args),
			copilotAcp: isCopilotAcpCommand(spawnCommand, args),
			claudeAcp: isClaudeAcpCommand(spawnCommand, args),
			spawnOptions: buildAgentSpawnOptions(this.options.cwd, this.options.authCredentials, this.options.sessionOptions?.env, this.options.agentProcessEnv)
		};
	}
	logAgentLaunch(plan) {
		const launch = plan.resolvedBuiltInLaunch;
		if (launch?.source === "installed") {
			this.log(`spawning installed built-in agent ${launch.packageName}${launch.packageVersion ? `@${launch.packageVersion}` : ""} via ${plan.spawnCommand} ${plan.args.join(" ")}`);
			return;
		}
		if (launch?.source === "package-exec") {
			this.log(`spawning built-in agent ${launch.packageName}@${launch.packageRange} via current Node package exec bridge ${plan.spawnCommand} ${plan.args.join(" ")}`);
			return;
		}
		this.log(`spawning agent: ${plan.spawnCommand} ${plan.args.join(" ")}`);
	}
	async ensureLaunchSupport(plan) {
		if (plan.copilotAcp) await ensureCopilotAcpSupport(plan.spawnCommand);
		if (!plan.claudeAcp) return;
		const claudeExe = resolveClaudeCodeExecutable(process.platform, plan.spawnOptions.env);
		if (claudeExe) {
			plan.spawnOptions.env.CLAUDE_CODE_EXECUTABLE = claudeExe;
			this.log(`resolved system Claude Code executable: ${claudeExe}`);
		}
	}
	async spawnAgentProcess(plan) {
		const spawnCommand = buildAgentSpawnCommand(plan.spawnCommand, plan.args, process.platform, plan.spawnOptions.env);
		const launch = Object.freeze({
			launchId: randomUUID(),
			scope: snapshotProcessLaunchScope(this.options.processLaunchScope),
			command: spawnCommand.command,
			args: Object.freeze([...spawnCommand.args]),
			cwd: this.options.cwd
		});
		await this.options.processLifecycle?.onBeforeSpawn?.(launch);
		let spawnedChild;
		try {
			spawnedChild = spawn(spawnCommand.command, spawnCommand.args, {
				...plan.spawnOptions,
				windowsVerbatimArguments: spawnCommand.windowsVerbatimArguments
			});
			await waitForSpawn(spawnedChild);
		} catch (error) {
			const spawnError = new AgentSpawnError(this.options.agentCommand, error);
			this.notifyProcessSpawnFailure(launch, spawnError);
			throw spawnError;
		}
		const child = requireAgentStdio(spawnedChild);
		this.agentDescendants.set(child, new ProcessDescendants(child));
		const pid = child.pid;
		if (pid === void 0) {
			const spawnError = new AgentSpawnError(this.options.agentCommand, /* @__PURE__ */ new Error("spawned agent process did not expose a PID"));
			this.notifyProcessSpawnFailure(launch, spawnError);
			await this.terminateAgentProcess(child);
			throw spawnError;
		}
		return {
			child,
			process: Object.freeze({
				...launch,
				pid,
				startedAt: isoNow$2()
			})
		};
	}
	async admitAndObserveSpawnedProcess(child, process) {
		let releaseExitNotification = () => {};
		const exitNotificationBarrier = new Promise((resolve) => {
			releaseExitNotification = resolve;
		});
		this.attachAgentLifecycleObservers(child, process, exitNotificationBarrier);
		try {
			await this.options.processLifecycle?.onSpawned?.(process);
		} catch (error) {
			await this.terminateAgentProcess(child);
			throw error;
		} finally {
			releaseExitNotification();
		}
	}
	createConnection(stream, launch) {
		const app = client({ name: "acpx" }).onNotification(methods.client.session.update, async ({ params }) => {
			await this.handleSessionUpdate(params);
		}).onNotification(methods.client.elicitation.complete, async () => {}).onRequest(methods.client.session.requestPermission, async ({ params }) => {
			return await this.handlePermissionRequest(params);
		}).onRequest(methods.client.elicitation.create, async ({ params, requestId, signal }) => {
			return await this.handleElicitationRequest(params, requestId, signal);
		}).onRequest(methods.client.fs.readTextFile, async ({ params }) => {
			return await this.handleReadTextFile(params);
		}).onRequest(methods.client.fs.writeTextFile, async ({ params }) => {
			return await this.handleWriteTextFile(params);
		}).onRequest(methods.client.terminal.create, async ({ params }) => {
			return await this.handleCreateTerminal(params);
		}).onRequest(methods.client.terminal.output, async ({ params }) => {
			return await this.terminalManager.terminalOutput(params);
		}).onRequest(methods.client.terminal.waitForExit, async ({ params }) => {
			return await this.terminalManager.waitForTerminalExit(params);
		}).onRequest(methods.client.terminal.kill, async ({ params }) => {
			return await this.terminalManager.killTerminal(params);
		}).onRequest(methods.client.terminal.release, async ({ params }) => {
			return await this.terminalManager.releaseTerminal(params);
		});
		if (launch.devinAcp) app.onRequest("_cognition.ai/request_diagnostics", (params) => {
			return params && typeof params === "object" && !Array.isArray(params) ? params : {};
		}, async () => ({}));
		return app.connect(stream);
	}
	async initializeAgentConnection(params) {
		try {
			const initResult = await Promise.race([this.initializeProtocolConnection(params.connection, params.launch), params.startupFailure.promise]);
			params.startupFailure.dispose();
			this.connection = params.connection;
			this.initResult = initResult;
			await this.captureAgentDescendants(params.child);
			this.log(`initialized protocol version ${initResult.protocolVersion}`);
		} catch (error) {
			params.connection.close(error);
			await this.handleInitializeFailure(params, error);
		}
	}
	async initializeProtocolConnection(connection, launch) {
		const initializePromise = connection.agent.request(methods.agent.initialize, {
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: resolveClientCapabilities({
				devinAcp: launch.devinAcp,
				fs: this.options.fs !== false,
				terminal: this.options.terminal !== false,
				elicitationModes: this.options.elicitationModes ?? []
			}),
			clientInfo: resolveClientInfo(launch.devinAcp)
		});
		const initialized = launch.geminiAcp ? await withTimeout(initializePromise, resolveGeminiAcpStartupTimeoutMs()) : await initializePromise;
		await this.authenticateIfRequired(connection, initialized.authMethods ?? []);
		return initialized;
	}
	async handleInitializeFailure(params, error) {
		params.startupFailure.dispose();
		await this.captureAgentDescendants(params.child);
		const normalizedError = error instanceof AcpMessageLimitError ? error : await this.normalizeInitializeError(error, params.child, params.startupStderr);
		await this.terminateAgentProcess(params.child);
		if (params.launch.geminiAcp && error instanceof TimeoutError) throw new GeminiAcpStartupTimeoutError(await buildGeminiAcpStartupTimeoutMessage(params.launch.spawnCommand), {
			cause: error,
			retryable: true
		});
		throw normalizedError;
	}
	createTappedStream(base) {
		return observeAcpStream(base, {
			onMessage: (direction, message) => {
				this.eventHandlers.onAcpOutputMessage?.(direction, message);
				this.eventHandlers.onAcpMessage?.(direction, message);
			},
			suppressReplaySessionUpdates: () => this.suppressReplaySessionUpdateMessages,
			bindPromptOwner: (owner) => this.bindPromptOwner(owner),
			onPromptRequestWritten: (active, owner) => this.onPromptRequestWritten(active, owner)
		});
	}
	async createSession(cwd = this.options.cwd) {
		const connection = this.getConnection();
		const { command, args } = resolveAgentCommandParts(this.options.agentCommand, this.options.agentArgv);
		const claudeAcp = isClaudeAcpCommand(command, args);
		const sessionCwd = await resolveAgentSessionCwd(cwd, this.options.agentCommand);
		let result;
		try {
			const createPromise = this.runConnectionRequest(() => connection.agent.request(methods.agent.session.new, {
				cwd: sessionCwd,
				mcpServers: this.options.mcpServers ?? [],
				_meta: buildClaudeCodeOptionsMeta(this.options.sessionOptions, claudeAcp)
			}));
			result = claudeAcp ? await withTimeout(createPromise, resolveClaudeAcpSessionCreateTimeoutMs()) : await createPromise;
		} catch (error) {
			if (claudeAcp && error instanceof TimeoutError) throw new ClaudeAcpSessionCreateTimeoutError(buildClaudeAcpSessionCreateTimeoutMessage(), {
				cause: error,
				retryable: true
			});
			throw error;
		}
		this.loadedSessionId = result.sessionId;
		const configOptions = normalizeResponseConfigOptions(result);
		const models = modelStateFromSessionResponse({
			configOptions,
			response: result
		});
		this.rememberSessionModels(result.sessionId, models);
		await this.captureAgentDescendants(this.agent);
		return {
			sessionId: result.sessionId,
			agentSessionId: extractAgentSessionId(result._meta),
			configOptions,
			models,
			configOptionsPresent: hasResponseField(result, "configOptions"),
			legacyModelMetadataPresent: hasResponseField(result, "models")
		};
	}
	async loadSession(sessionId, cwd = this.options.cwd) {
		this.getConnection();
		return await this.loadSessionWithOptions(sessionId, cwd, {});
	}
	async loadSessionWithOptions(sessionId, cwd = this.options.cwd, options = {}) {
		const connection = this.getConnection();
		const sessionCwd = await resolveAgentSessionCwd(cwd, this.options.agentCommand);
		const previousSuppression = this.applySessionUpdateSuppression(Boolean(options.suppressReplayUpdates));
		let response;
		try {
			response = await this.runConnectionRequest(() => connection.agent.request(methods.agent.session.load, {
				sessionId,
				cwd: sessionCwd,
				mcpServers: this.options.mcpServers ?? []
			}));
			await this.waitForSessionUpdateDrain(options.replayIdleMs ?? REPLAY_IDLE_MS, options.replayDrainTimeoutMs ?? REPLAY_DRAIN_TIMEOUT_MS);
		} finally {
			this.restoreSessionUpdateSuppression(previousSuppression);
		}
		this.loadedSessionId = sessionId;
		const result = toReconnectedSessionResult(response);
		this.updateRememberedSessionModels(sessionId, result);
		await this.captureAgentDescendants(this.agent);
		return result;
	}
	async resumeSession(sessionId, cwd = this.options.cwd) {
		const connection = this.getConnection();
		const sessionCwd = await resolveAgentSessionCwd(cwd, this.options.agentCommand);
		const response = await this.runConnectionRequest(() => connection.agent.request(methods.agent.session.resume, {
			sessionId,
			cwd: sessionCwd,
			mcpServers: this.options.mcpServers ?? []
		}));
		this.loadedSessionId = sessionId;
		const result = toReconnectedSessionResult(response);
		this.updateRememberedSessionModels(sessionId, result);
		await this.captureAgentDescendants(this.agent);
		return result;
	}
	applySessionUpdateSuppression(enabled) {
		const previous = {
			suppressSessionUpdates: this.suppressSessionUpdates,
			suppressReplaySessionUpdateMessages: this.suppressReplaySessionUpdateMessages
		};
		this.suppressSessionUpdates = previous.suppressSessionUpdates || enabled;
		this.suppressReplaySessionUpdateMessages = previous.suppressReplaySessionUpdateMessages || enabled;
		return previous;
	}
	restoreSessionUpdateSuppression(previous) {
		this.suppressSessionUpdates = previous.suppressSessionUpdates;
		this.suppressReplaySessionUpdateMessages = previous.suppressReplaySessionUpdateMessages;
	}
	async prompt(sessionId, prompt, onRequestWritten, onElicitation, onPermissionRequest) {
		const connection = this.getConnection();
		const normalizedPrompt = this.normalizePromptForAgent(prompt);
		const restoreConsoleError = this.options.suppressSdkConsoleErrors ? installSdkConsoleErrorSuppression() : void 0;
		const previousActivePrompt = this.activePrompt;
		const activePrompt = this.beginActivePrompt(sessionId, onRequestWritten, onElicitation, onPermissionRequest);
		let promptPromise;
		try {
			promptPromise = this.runConnectionRequest(() => connection.agent.request(methods.agent.session.prompt, {
				sessionId,
				prompt: normalizedPrompt
			}));
		} catch (error) {
			this.clearActivePrompt(activePrompt);
			restoreConsoleError?.();
			throw error;
		}
		activePrompt.promise = promptPromise;
		try {
			previousActivePrompt?.elicitationController?.abort();
			return this.returnPromptResponseOrPermissionFailure(sessionId, await promptPromise);
		} catch (error) {
			this.throwPromptPermissionFailureIfPresent(sessionId);
			throw error;
		} finally {
			restoreConsoleError?.();
			this.clearActivePrompt(activePrompt);
		}
	}
	beginActivePrompt(sessionId, onRequestWritten, elicitationHandler, permissionHandler) {
		this.cancellingSessionIds.delete(sessionId);
		const active = {
			sessionId,
			onRequestWritten,
			elicitationHandler,
			permissionHandler,
			elicitationController: new AbortController()
		};
		this.activePrompt = active;
		this.pendingPromptOwners.push(active);
		return active;
	}
	bindPromptOwner(owner) {
		const active = this.pendingPromptOwners.find((candidate) => {
			return candidate.requestId === void 0 && candidate.sessionId === owner.sessionId;
		});
		if (active) active.requestId = owner.requestId;
		return active;
	}
	onPromptRequestWritten(active, owner) {
		if (active.requestId !== owner.requestId || active.sessionId !== owner.sessionId) return;
		try {
			Promise.resolve(active.onRequestWritten?.()).catch(() => {});
		} catch {}
	}
	clearActivePrompt(active) {
		const pendingIndex = this.pendingPromptOwners.indexOf(active);
		const clearSession = !this.pendingPromptOwners.some((candidate, index) => index > pendingIndex && candidate.sessionId === active.sessionId);
		if (this.activePrompt === active) this.activePrompt = void 0;
		if (pendingIndex >= 0) this.pendingPromptOwners.splice(pendingIndex, 1);
		let permissionController;
		if (clearSession) {
			this.cancellingSessionIds.delete(active.sessionId);
			permissionController = this.takePermissionAbortController(active.sessionId);
			this.promptPermissionFailures.delete(active.sessionId);
		}
		active.elicitationController.abort();
		permissionController?.abort();
	}
	normalizePromptForAgent(prompt) {
		const normalizedPrompt = typeof prompt === "string" ? textPrompt(prompt) : prompt;
		const unsupportedPromptContent = getUnsupportedPromptContentMessage(normalizedPrompt, this.initResult?.agentCapabilities);
		if (unsupportedPromptContent) throw new UnsupportedPromptContentError(unsupportedPromptContent);
		return normalizedPrompt;
	}
	returnPromptResponseOrPermissionFailure(sessionId, response) {
		this.throwPromptPermissionFailureIfPresent(sessionId);
		return response;
	}
	throwPromptPermissionFailureIfPresent(sessionId) {
		const permissionFailure = this.consumePromptPermissionFailure(sessionId);
		if (permissionFailure) throw permissionFailure;
	}
	async setSessionMode(sessionId, modeId) {
		const connection = this.getConnection();
		try {
			await this.runConnectionRequest(() => connection.agent.request(methods.agent.session.setMode, {
				sessionId,
				modeId
			}));
		} catch (error) {
			throw maybeWrapSessionControlError("session/set_mode", error, `for mode "${modeId}"`);
		}
	}
	async setSessionConfigOption(sessionId, configId, value) {
		const connection = this.getConnection();
		try {
			return await this.runConnectionRequest(() => connection.agent.request(methods.agent.session.setConfigOption, {
				sessionId,
				configId,
				value
			}));
		} catch (error) {
			throw maybeWrapSessionControlError("session/set_config_option", error, `for "${configId}"="${value}"`);
		}
	}
	async setSessionModel(sessionId, modelId, controlOverride) {
		const control = this.resolveModelControl(sessionId, controlOverride);
		if (!control) throw new RequestedModelUnsupportedError(`Cannot set model "${modelId}": the ACP session did not advertise a model config option or legacy session/set_model support.`, "missing-capability");
		const resolvedModelId = resolveRequestedModelId({
			requestedModel: modelId,
			models: controlOverride?.availableModels ? { availableModels: controlOverride.availableModels } : void 0,
			agentCommand: this.options.agentCommand
		});
		return control.kind === "config_option" ? await this.setSessionModelThroughConfig(sessionId, resolvedModelId, control.configId) : await this.setSessionModelThroughLegacyMethod(sessionId, resolvedModelId);
	}
	async setSessionModelThroughConfig(sessionId, modelId, configId) {
		const connection = this.getConnection();
		try {
			const response = await this.runConnectionRequest(() => connection.agent.request(methods.agent.session.setConfigOption, {
				sessionId,
				configId,
				value: modelId
			}));
			this.rememberSessionModels(sessionId, modelStateFromConfigOptions(response.configOptions));
			return response;
		} catch (error) {
			return this.throwSessionModelError("session/set_config_option", modelId, error);
		}
	}
	async setSessionModelThroughLegacyMethod(sessionId, modelId) {
		const connection = this.getConnection();
		try {
			await this.runConnectionRequest(() => connection.agent.request("session/set_model", {
				sessionId,
				modelId
			}));
			return;
		} catch (error) {
			return this.throwSessionModelError("session/set_model", modelId, error);
		}
	}
	throwSessionModelError(method, modelId, error) {
		const wrapped = maybeWrapSessionControlError(method, error, `for model "${modelId}"`);
		if (wrapped !== error) throw wrapped;
		const acp = extractAcpError(error);
		const summary = acp ? formatSessionControlAcpSummary(acp) : error instanceof Error ? error.message : String(error);
		throw new Error(`Failed ${method} for model "${modelId}": ${summary}`, { cause: error });
	}
	resolveModelControl(sessionId, controlOverride) {
		if (controlOverride) return controlOverride.configId ? {
			kind: "config_option",
			configId: controlOverride.configId
		} : { kind: "legacy_set_model" };
		const configId = this.modelConfigIds.get(sessionId);
		if (configId) return {
			kind: "config_option",
			configId
		};
		return this.legacyModelSessionIds.has(sessionId) ? { kind: "legacy_set_model" } : void 0;
	}
	rememberSessionModels(sessionId, models) {
		if (!models) {
			this.modelConfigIds.delete(sessionId);
			this.legacyModelSessionIds.delete(sessionId);
			return;
		}
		if (models.configId) {
			this.modelConfigIds.set(sessionId, models.configId);
			this.legacyModelSessionIds.delete(sessionId);
			return;
		}
		this.modelConfigIds.delete(sessionId);
		this.legacyModelSessionIds.add(sessionId);
	}
	updateRememberedSessionModels(sessionId, result) {
		const explicitConfigRemoval = result.configOptionsPresent && this.modelConfigIds.has(sessionId);
		if (result.models || result.legacyModelMetadataPresent || explicitConfigRemoval) this.rememberSessionModels(sessionId, result.models);
	}
	async cancel(sessionId) {
		const connection = this.getConnection();
		const active = this.activePrompt?.sessionId === sessionId ? this.activePrompt : void 0;
		const cancellation = active?.cancelPromise ?? this.runConnectionRequest(() => connection.agent.notify(methods.agent.session.cancel, { sessionId })).catch((error) => {
			if (active?.cancelPromise === cancellation) active.cancelPromise = void 0;
			throw error;
		});
		const permissionController = this.takePermissionAbortController(sessionId);
		if (active) {
			active.cancelPromise = cancellation;
			this.cancellingSessionIds.add(sessionId);
			active.elicitationController?.abort();
		} else this.cancellingSessionIds.delete(sessionId);
		permissionController?.abort();
		await cancellation;
	}
	async closeSession(sessionId) {
		const connection = this.getConnection();
		this.cancellingSessionIds.add(sessionId);
		if (this.activePrompt?.sessionId === sessionId) this.activePrompt.elicitationController?.abort();
		await this.runConnectionRequest(() => connection.agent.request(methods.agent.session.close, { sessionId }));
		if (this.loadedSessionId === sessionId) this.loadedSessionId = void 0;
		this.modelConfigIds.delete(sessionId);
		this.legacyModelSessionIds.delete(sessionId);
	}
	async listSessions(params = {}) {
		const connection = this.getConnection();
		return await this.runConnectionRequest(() => connection.agent.request(methods.agent.session.list, params));
	}
	async requestCancelActivePrompt() {
		const active = this.activePrompt;
		if (!active) return false;
		await this.cancel(active.sessionId);
		return true;
	}
	async cancelActivePrompt(waitMs = 2500) {
		const active = this.activePrompt;
		if (!active) return;
		try {
			await this.cancel(active.sessionId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.log(`failed to send session/cancel: ${message}`);
		}
		if (waitMs <= 0) return;
		const activePromise = active.promise;
		if (!activePromise) return;
		let timer;
		const timeoutPromise = new Promise((resolve) => {
			timer = setTimeout(resolve, waitMs);
		});
		try {
			return await Promise.race([activePromise.then((response) => response, () => void 0), timeoutPromise]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
	async close() {
		this.closing = true;
		this.abortActiveElicitation();
		await this.terminalManager.shutdown();
		const agent = this.agent;
		if (agent) await this.terminateAgentProcess(agent);
		this.closeConnection();
		if (this.pendingConnectionRequests.size > 0) this.rejectPendingConnectionRequests(this.lastAgentExit ? new AgentDisconnectedError(this.lastAgentExit.reason, this.lastAgentExit.exitCode, this.lastAgentExit.signal, { outputAlreadyEmitted: Boolean(this.activePrompt) }) : new AgentDisconnectedError("connection_close", null, null, { outputAlreadyEmitted: Boolean(this.activePrompt) }));
		this.sessionUpdateChain = Promise.resolve();
		this.observedSessionUpdates = 0;
		this.processedSessionUpdates = 0;
		this.suppressSessionUpdates = false;
		this.suppressReplaySessionUpdateMessages = false;
		this.activePrompt = void 0;
		this.pendingPromptOwners.length = 0;
		this.cancellingSessionIds.clear();
		for (const controller of this.permissionAbortControllers.values()) controller.abort();
		this.permissionAbortControllers.clear();
		this.promptPermissionFailures.clear();
		this.loadedSessionId = void 0;
		this.modelConfigIds.clear();
		this.legacyModelSessionIds.clear();
		this.initResult = void 0;
		this.connection = void 0;
		this.agent = void 0;
	}
	abortActiveElicitation() {
		this.activePrompt?.elicitationController?.abort();
	}
	closeConnection() {
		this.connection?.close();
	}
	async captureAgentDescendants(child) {
		const descendants = child && this.agentDescendants.get(child);
		if (descendants && !await descendants.capture()) this.log("could not verify agent descendants; skipping unverified process cleanup");
	}
	terminateAgentProcess(child) {
		let cleanup = this.agentCleanups.get(child);
		if (!cleanup) {
			cleanup = Promise.resolve().then(() => this.cleanupAgentProcess(child));
			this.agentCleanups.set(child, cleanup);
		}
		return cleanup;
	}
	async cleanupAgentProcess(child) {
		const descendants = this.agentDescendants.get(child);
		const deadline = Date.now() + AGENT_CLEANUP_BUDGET_MS;
		const stdinCloseGraceMs = resolveAgentCloseAfterStdinEndMs(this.options.agentCommand);
		try {
			if (descendants) await descendants.capture(Math.max(1, deadline - Date.now()));
			this.endAgentStdin(child);
			await waitForChildExit(child, Math.min(stdinCloseGraceMs, Math.max(0, deadline - Date.now())));
			if (!await this.signalAgentAndDescendants(child, "SIGTERM", AGENT_CLOSE_TERM_GRACE_MS, deadline)) {
				this.log("agent processes did not exit after SIGTERM; forcing SIGKILL");
				await this.signalAgentAndDescendants(child, "SIGKILL", AGENT_CLOSE_KILL_GRACE_MS, deadline);
			}
		} finally {
			descendants?.retire();
			this.detachAgentHandles(child, isChildProcessRunning(child));
		}
	}
	endAgentStdin(child) {
		if (child.stdin.destroyed) return;
		try {
			child.stdin.end();
		} catch {}
	}
	async signalAgentAndDescendants(child, signal, waitMs, deadline) {
		const descendants = this.agentDescendants.get(child);
		if (descendants && Date.now() < deadline) await descendants.signal(signal, deadline - Date.now());
		if (isChildProcessRunning(child)) try {
			child.kill(signal);
		} catch {}
		const remaining = Math.min(waitMs, Math.max(0, deadline - Date.now()));
		const [exited, descendantsExited] = await Promise.all([waitForChildExit(child, remaining), descendants ? descendants.waitForExit(remaining) : Promise.resolve(true)]);
		return exited && descendantsExited;
	}
	detachAgentHandles(agent, unref) {
		const stdin = agent.stdin;
		const stdout = agent.stdout;
		const stderr = agent.stderr;
		stdin?.destroy();
		stdout?.destroy();
		stderr?.destroy();
		if (unref) try {
			agent.unref();
		} catch {}
	}
	getConnection() {
		if (!this.connection) throw new Error("ACP client not started");
		return this.connection;
	}
	log(message) {
		if (!this.options.verbose) return;
		process.stderr.write(`[acpx] ${message}\n`);
	}
	captureStartupStderr(target, chunk) {
		const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		if (text.length === 0) return;
		target.push(text);
		if (target.join("").length - STARTUP_STDERR_MAX_CHARS <= 0) return;
		const joined = target.join("");
		target.splice(0, target.length, joined.slice(-8192));
	}
	summarizeStartupStderr(target) {
		const joined = target.join("").trim();
		if (!joined) return;
		return joined.replace(/\s+/gu, " ").trim().slice(0, STARTUP_STDERR_MAX_CHARS);
	}
	createStartupFailureWatcher(child, startupStderr) {
		let settled = false;
		let failure;
		let rejectPromise;
		const cleanup = () => {
			child.off("error", onError);
			child.off("exit", onExit);
			child.off("close", onClose);
		};
		const finish = (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) {
				failure = error;
				rejectPromise(error);
			}
		};
		const createError = (params) => new AgentStartupError({
			agentCommand: this.options.agentCommand,
			exitCode: params?.exitCode ?? child.exitCode ?? null,
			signal: params?.signal ?? child.signalCode ?? null,
			stderrSummary: this.summarizeStartupStderr(startupStderr),
			cause: params?.cause
		});
		const onError = (error) => {
			finish(createError({ cause: error }));
		};
		const onExit = (exitCode, signal) => {
			finish(createError({
				exitCode,
				signal
			}));
		};
		const onClose = (exitCode, signal) => {
			finish(createError({
				exitCode,
				signal
			}));
		};
		const promise = new Promise((_resolve, reject) => {
			rejectPromise = reject;
			child.once("error", onError);
			child.once("exit", onExit);
			child.once("close", onClose);
			if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
		});
		promise.catch(() => {});
		return {
			promise,
			dispose: () => finish(),
			getError: () => failure
		};
	}
	async normalizeInitializeError(error, child, startupStderr) {
		if (error instanceof AgentStartupError) return error;
		const connectionClosedDuringInitialize = error instanceof Error && /acp connection closed/i.test(error.message);
		await waitForChildExit(child, 100);
		const childExited = child.exitCode !== null || child.signalCode !== null;
		if (!connectionClosedDuringInitialize && !childExited) return error;
		return new AgentStartupError({
			agentCommand: this.options.agentCommand,
			exitCode: child.exitCode ?? null,
			signal: child.signalCode ?? null,
			stderrSummary: this.summarizeStartupStderr(startupStderr),
			cause: error
		});
	}
	selectAuthMethod(methods) {
		for (const method of methods) {
			const envCredential = readEnvCredential(method.id);
			if (envCredential) return {
				methodId: method.id,
				credential: envCredential,
				source: "env"
			};
			const configCredential = resolveConfiguredAuthCredential(method.id, this.options.authCredentials);
			if (typeof configCredential === "string" && configCredential.trim().length > 0) return {
				methodId: method.id,
				credential: configCredential,
				source: "config"
			};
			const agentSpecificEnvCredential = this.readAgentSpecificEnvCredential(method.id);
			if (agentSpecificEnvCredential) return {
				methodId: method.id,
				credential: agentSpecificEnvCredential,
				source: "env"
			};
		}
		for (const method of methods) {
			const agentManagedSelection = this.selectAgentManagedAuthMethod(method.id);
			if (agentManagedSelection) return agentManagedSelection;
		}
	}
	readAgentSpecificEnvCredential(methodId) {
		if (!this.isGrokBuildAcpCommand() || methodId !== "xai.api_key") return;
		const value = process.env.XAI_API_KEY;
		return typeof value === "string" && value.trim().length > 0 ? value : void 0;
	}
	selectAgentManagedAuthMethod(methodId) {
		if (!this.isGrokBuildAcpCommand() || methodId !== "cached_token") return;
		return {
			methodId,
			source: "agent"
		};
	}
	isGrokBuildAcpCommand() {
		const { command, args } = resolveAgentCommandParts(this.options.agentCommand, this.options.agentArgv);
		return command.replace(/\\/g, "/").split("/").pop()?.replace(/\.(cmd|exe|ps1)$/iu, "").toLowerCase() === "grok" && args[0] === "agent" && args[1] === "stdio";
	}
	async authenticateIfRequired(connection, authMethods) {
		if (authMethods.length === 0) return;
		const selected = this.selectAuthMethod(authMethods);
		if (!selected) {
			if (this.options.authPolicy === "fail") throw new AuthPolicyError(`agent advertised auth methods [${authMethods.map((m) => m.id).join(", ")}] but no matching credentials found`);
			this.log(`agent advertised auth methods [${authMethods.map((m) => m.id).join(", ")}] but no matching credentials found — skipping (agent may handle auth internally)`);
			return;
		}
		await connection.agent.request(methods.agent.authenticate, { methodId: selected.methodId });
		this.log(`authenticated with method ${selected.methodId} (${selected.source})`);
	}
	async handlePermissionRequest(params) {
		if (this.cancellingSessionIds.has(params.sessionId)) return cancelledPermissionResponse();
		const hostResponse = await this.tryHandlePermissionRequestWithHost(params);
		if (hostResponse) return hostResponse;
		const { response, recorded } = await this.resolvePermissionRequestFromMode(params);
		if (!recorded) {
			const decision = classifyPermissionDecision(params, response);
			this.recordPermissionDecision(decision);
		}
		return response;
	}
	async handleElicitationRequest(request, requestId, requestSignal) {
		const resolved = this.resolveElicitationOwner(request);
		if ("response" in resolved) return resolved.response;
		const { active, handler } = resolved.owner;
		const signal = AbortSignal.any([requestSignal, active.elicitationController.signal]);
		const outcome = await raceWithAbort(signal, Promise.resolve().then(async () => await handler(request, {
			requestId,
			signal
		})).then((response) => ({
			kind: "response",
			response
		}), (error) => ({
			kind: "error",
			error
		})));
		if (this.activePrompt !== active) return cancelledElicitationResponse(ELICITATION_CANCEL_MESSAGES.inactive);
		if (!outcome || signal.aborted) return cancelledElicitationResponse(ELICITATION_CANCEL_MESSAGES.cancelled);
		if (outcome.kind === "error" || !isKnownElicitationResponse(outcome.response)) return cancelledElicitationResponse(ELICITATION_CANCEL_MESSAGES.unavailable);
		return outcome.response;
	}
	resolveElicitationOwner(request) {
		if (!this.options.elicitationModes?.includes(request.mode)) return { response: cancelledElicitationResponse(ELICITATION_CANCEL_MESSAGES.unsupported) };
		const active = this.activePrompt;
		if (!active) return { response: cancelledElicitationResponse(ELICITATION_CANCEL_MESSAGES.inactive) };
		const scope = this.resolveElicitationScope(request, active);
		if ("response" in scope) return scope;
		if (this.isElicitationSessionCancelling(scope.sessionId)) return { response: cancelledElicitationResponse(ELICITATION_CANCEL_MESSAGES.cancelled) };
		if (!active.elicitationHandler) return { response: cancelledElicitationResponse(ELICITATION_CANCEL_MESSAGES.unavailable) };
		return { owner: {
			active,
			handler: active.elicitationHandler
		} };
	}
	resolveElicitationScope(request, active) {
		const sessionId = elicitationSessionId(request);
		if (sessionId) return sessionId === active.sessionId ? { sessionId } : { response: cancelledElicitationResponse(ELICITATION_CANCEL_MESSAGES.mismatchedSession) };
		const requestScopeId = elicitationRequestScopeId(request);
		if (requestScopeId === void 0 || requestScopeId !== active.requestId) return { response: cancelledElicitationResponse(ELICITATION_CANCEL_MESSAGES.requestScoped) };
		return { sessionId: active.sessionId };
	}
	isElicitationSessionCancelling(sessionId) {
		return this.closing || this.cancellingSessionIds.has(sessionId);
	}
	resolvePermissionOwner(sessionId) {
		const active = this.activePrompt;
		const handler = active?.permissionHandler ?? this.options.onPermissionRequest;
		if (!handler) return;
		const signal = this.cancellationSignalForSession(sessionId);
		if (!active?.permissionHandler) return {
			handler,
			signal
		};
		return {
			handler,
			signal: active.sessionId === sessionId ? AbortSignal.any([signal, active.elicitationController.signal]) : AbortSignal.abort()
		};
	}
	async tryHandlePermissionRequestWithHost(params) {
		const owner = this.resolvePermissionOwner(params.sessionId);
		if (!owner) return;
		const { handler, signal } = owner;
		if (signal.aborted) return this.hostPermissionDecisionResponse(params, signal, void 0);
		try {
			const decision = await raceWithAbort(signal, handler({
				sessionId: params.sessionId,
				raw: params,
				inferredKind: inferToolKind(params)
			}, { signal }));
			return this.hostPermissionDecisionResponse(params, signal, decision);
		} catch (error) {
			return this.hostPermissionErrorResponse(params, signal, error);
		}
	}
	hostPermissionDecisionResponse(params, signal, decision) {
		if (signal.aborted || this.cancellingSessionIds.has(params.sessionId)) {
			this.recordPermissionDecision("cancelled");
			return cancelledPermissionResponse();
		}
		if (!decision) return;
		const response = decisionToResponse(preferCodexPermissionRefusal(params, this.initResult?.agentInfo?.name), decision);
		this.recordPermissionDecision(classifyPermissionDecision(params, response));
		return decision.outcome === "cancel" ? response : this.explainPermissionRefusal(params, response);
	}
	hostPermissionErrorResponse(params, signal, error) {
		if (signal.aborted || this.cancellingSessionIds.has(params.sessionId)) {
			this.recordPermissionDecision("cancelled");
			return cancelledPermissionResponse();
		}
		this.log(`onPermissionRequest threw, falling through to mode-based resolver: ${error instanceof Error ? error.message : String(error)}`);
	}
	async resolvePermissionRequestFromMode(params) {
		try {
			const result = await resolvePermissionRequestWithDetails(preferCodexPermissionRefusal(params, this.initResult?.agentInfo?.name), this.options.permissionMode, this.options.nonInteractivePermissions ?? "deny", this.options.permissionPolicy);
			this.emitPermissionEscalation(result.escalation);
			return {
				response: this.explainPermissionRefusal(params, result.response),
				recorded: false
			};
		} catch (error) {
			return this.handleModePermissionError(params.sessionId, error);
		}
	}
	explainPermissionRefusal(params, response) {
		const notice = codexPermissionNotice(params, response, this.initResult?.agentInfo?.name);
		if (!notice || this.cancellingSessionIds.has(params.sessionId)) return response;
		try {
			this.eventHandlers.onClientOperation?.({
				method: "session/request_permission",
				status: "completed",
				summary: notice,
				timestamp: isoNow$2()
			});
		} catch {}
		return withPermissionMetadata(response, { permissionNotice: notice });
	}
	emitPermissionEscalation(escalation) {
		if (escalation) this.eventHandlers.onPermissionEscalation?.(escalation);
	}
	handleModePermissionError(sessionId, error) {
		if (!(error instanceof PermissionPromptUnavailableError)) throw error;
		this.notePromptPermissionFailure(sessionId, error);
		this.recordPermissionDecision("cancelled");
		return {
			response: cancelledPermissionResponse(),
			recorded: true
		};
	}
	attachAgentLifecycleObservers(child, startedProcess, exitNotificationBarrier) {
		const onExit = (exitCode, signal) => {
			const exitedAt = isoNow$2();
			this.recordAgentExit(child, "process_exit", exitCode, signal);
			this.terminateAgentProcess(child);
			exitNotificationBarrier.then(() => {
				this.notifyProcessExit(startedProcess, exitCode, signal, exitedAt);
			});
		};
		child.once("exit", onExit);
		if (child.exitCode !== null || child.signalCode !== null) {
			child.off("exit", onExit);
			onExit(child.exitCode, child.signalCode);
		}
		child.once("close", (exitCode, signal) => {
			this.recordAgentExit(child, "process_close", exitCode, signal);
		});
		child.stdout.once("close", () => {
			this.recordAgentExit(child, "pipe_close", child.exitCode ?? null, child.signalCode ?? null);
		});
	}
	notifyProcessSpawnFailure(launch, error) {
		const handler = this.options.processLifecycle?.onSpawnFailed;
		if (!handler) return;
		const event = Object.freeze({
			...launch,
			error,
			failedAt: isoNow$2()
		});
		try {
			Promise.resolve(handler(event)).catch((observerError) => {
				this.logProcessLifecycleError("onSpawnFailed", observerError);
			});
		} catch (observerError) {
			this.logProcessLifecycleError("onSpawnFailed", observerError);
		}
	}
	notifyProcessExit(startedProcess, exitCode, signal, exitedAt) {
		const handler = this.options.processLifecycle?.onExit;
		if (!handler) return;
		const event = Object.freeze({
			...startedProcess,
			exitCode,
			signal,
			exitedAt
		});
		try {
			Promise.resolve(handler(event)).catch((error) => {
				this.logProcessLifecycleError("onExit", error);
			});
		} catch (error) {
			this.logProcessLifecycleError("onExit", error);
		}
	}
	logProcessLifecycleError(hook, error) {
		const message = error instanceof Error ? error.message : String(error);
		this.log(`process lifecycle ${hook} hook failed: ${message}`);
	}
	recordAgentExit(child, reason, exitCode, signal) {
		if (this.agent !== child || this.lastAgentExit) return;
		this.lastAgentExit = {
			exitCode,
			signal,
			exitedAt: isoNow$2(),
			reason,
			unexpectedDuringPrompt: !this.closing && Boolean(this.activePrompt)
		};
		this.rejectPendingConnectionRequests(new AgentDisconnectedError(reason, exitCode, signal, { outputAlreadyEmitted: Boolean(this.activePrompt) }));
	}
	notePromptPermissionFailure(sessionId, error) {
		if (!this.promptPermissionFailures.has(sessionId)) this.promptPermissionFailures.set(sessionId, error);
	}
	consumePromptPermissionFailure(sessionId) {
		const error = this.promptPermissionFailures.get(sessionId);
		if (error) this.promptPermissionFailures.delete(sessionId);
		return error;
	}
	async runConnectionRequest(run) {
		return await new Promise((resolve, reject) => {
			const pending = {
				settled: false,
				reject
			};
			const finish = (cb) => {
				if (pending.settled) return;
				pending.settled = true;
				this.pendingConnectionRequests.delete(pending);
				cb();
			};
			this.pendingConnectionRequests.add(pending);
			Promise.resolve().then(async () => {
				if (pending.settled) return { started: false };
				return {
					started: true,
					value: await run()
				};
			}).then((outcome) => {
				if (outcome.started) finish(() => resolve(outcome.value));
			}, (error) => finish(() => reject(error)));
		});
	}
	rejectPendingConnectionRequests(error) {
		for (const pending of this.pendingConnectionRequests) {
			if (pending.settled) {
				this.pendingConnectionRequests.delete(pending);
				continue;
			}
			pending.settled = true;
			this.pendingConnectionRequests.delete(pending);
			pending.reject(error);
		}
	}
	async handleReadTextFile(params) {
		try {
			return await this.filesystem.readTextFile(params);
		} catch (error) {
			this.recordPermissionError(params.sessionId, error);
			if (error instanceof FsSafeError && error.code === "not-found" || error instanceof Error && "code" in error && error.code === "ENOENT") throw RequestError.resourceNotFound(pathToFileURL(params.path).href);
			throw error;
		}
	}
	async handleWriteTextFile(params) {
		try {
			return await this.filesystem.writeTextFile(params);
		} catch (error) {
			this.recordPermissionError(params.sessionId, error);
			throw error;
		}
	}
	async handleCreateTerminal(params) {
		try {
			return await this.terminalManager.createTerminal(params);
		} catch (error) {
			this.recordPermissionError(params.sessionId, error);
			throw error;
		}
	}
	cancellationSignalForSession(sessionId) {
		let controller = this.permissionAbortControllers.get(sessionId);
		if (!controller) {
			controller = new AbortController();
			this.permissionAbortControllers.set(sessionId, controller);
		}
		return controller.signal;
	}
	takePermissionAbortController(sessionId) {
		const controller = this.permissionAbortControllers.get(sessionId);
		this.permissionAbortControllers.delete(sessionId);
		return controller;
	}
	recordPermissionDecision(decision) {
		this.permissionStats.requested += 1;
		if (decision === "approved") {
			this.permissionStats.approved += 1;
			return;
		}
		if (decision === "denied") {
			this.permissionStats.denied += 1;
			return;
		}
		this.permissionStats.cancelled += 1;
	}
	recordPermissionError(sessionId, error) {
		if (error instanceof PermissionPromptUnavailableError) {
			this.notePromptPermissionFailure(sessionId, error);
			this.recordPermissionDecision("cancelled");
			return;
		}
		if (error instanceof PermissionDeniedError) this.recordPermissionDecision("denied");
	}
	async handleSessionUpdate(notification) {
		const sequence = ++this.observedSessionUpdates;
		this.sessionUpdateChain = this.sessionUpdateChain.then(async () => {
			try {
				if (!this.suppressSessionUpdates) this.eventHandlers.onSessionUpdate?.(notification);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.log(`session update handler failed: ${message}`);
			} finally {
				this.processedSessionUpdates = sequence;
			}
		});
		await this.sessionUpdateChain;
	}
	async waitForSessionUpdateDrain(idleMs, timeoutMs) {
		const normalizedIdleMs = Math.max(0, idleMs);
		const normalizedTimeoutMs = Math.max(normalizedIdleMs, timeoutMs);
		const deadline = Date.now() + normalizedTimeoutMs;
		let lastObserved = this.observedSessionUpdates;
		let idleSince = Date.now();
		while (Date.now() <= deadline) {
			const observed = this.observedSessionUpdates;
			if (observed !== lastObserved) {
				lastObserved = observed;
				idleSince = Date.now();
			}
			if (this.processedSessionUpdates === this.observedSessionUpdates && Date.now() - idleSince >= normalizedIdleMs) {
				await this.sessionUpdateChain;
				if (this.processedSessionUpdates === this.observedSessionUpdates) return;
			}
			await new Promise((resolve) => {
				setTimeout(resolve, DRAIN_POLL_INTERVAL_MS);
			});
		}
		throw new Error(`Timed out waiting for session replay drain after ${normalizedTimeoutMs}ms`);
	}
	async waitForSessionUpdatesIdle(options) {
		await this.waitForSessionUpdateDrain(options?.idleMs ?? 0, options?.timeoutMs ?? 0);
	}
};
//#endregion
//#region src/session/model-state.ts
function configOptionsAreAuthoritative(state) {
	return state.model_control === "config_option";
}
function legacyModelState(state) {
	if (!Array.isArray(state.available_models)) return;
	return {
		currentModelId: state.current_model_id ?? "",
		availableModels: state.available_models.map((modelId) => ({
			modelId,
			name: state.available_model_names && Object.hasOwn(state.available_model_names, modelId) ? state.available_model_names[modelId] : modelId
		}))
	};
}
function advertisedModelState(state) {
	if (!state) return;
	const configModels = modelStateFromConfigOptions(state?.config_options);
	if (configModels) return configModels;
	if (configOptionsAreAuthoritative(state)) return;
	return legacyModelState(state);
}
function applyAdvertisedModelState(state, models) {
	state.current_model_id = models.currentModelId;
	state.available_models = models.availableModels.map((model) => model.modelId);
	state.available_model_names = Object.fromEntries(models.availableModels.map((model) => [model.modelId, model.name]));
	state.model_control = models.configId ? "config_option" : "legacy_set_model";
}
function clearAdvertisedModelState(state) {
	delete state.current_model_id;
	delete state.available_models;
	delete state.available_model_names;
	delete state.model_control;
}
function removeModelConfigOptions(state) {
	if (!state.config_options) return;
	state.config_options = state.config_options.filter((option) => option.category !== "model" && option.id !== "model");
}
function applyConfigOptionsModelState(state, configOptions) {
	const previousConfigModels = modelStateFromConfigOptions(state.config_options);
	const preservesLegacyControl = state.model_control === "legacy_set_model" || state.model_control === void 0 && previousConfigModels === void 0 && legacyModelState(state) !== void 0;
	state.config_options = structuredClone(configOptions);
	const models = modelStateFromConfigOptions(configOptions);
	if (models) applyAdvertisedModelState(state, models);
	else if (preservesLegacyControl) state.model_control = "legacy_set_model";
	else clearAdvertisedModelState(state);
}
//#endregion
//#region src/session/conversation-model.ts
const MAX_RUNTIME_MESSAGES = 200;
const MAX_RUNTIME_AGENT_TEXT_CHARS = 8e3;
const MAX_RUNTIME_THINKING_CHARS = 4e3;
const MAX_RUNTIME_TOOL_IO_CHARS = 4e3;
const MAX_RUNTIME_REQUEST_TOKEN_USAGE = 100;
function isoNow() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
function deepClone(value) {
	try {
		return structuredClone(value);
	} catch {
		return value;
	}
}
function hasOwn(source, key) {
	return Object.prototype.hasOwnProperty.call(source, key);
}
function normalizeAgentName(value) {
	return trimmedString(value);
}
function trimmedString(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function normalizeAvailableCommand(value) {
	const record = asRecord(value);
	if (!record) return;
	const name = trimmedString(record.name);
	if (!name) return;
	const description = trimmedString(record.description);
	return {
		name,
		...description ? { description } : {},
		has_input: record.input != null
	};
}
function extractText(content) {
	switch (content.type) {
		case "text": return content.text;
		case "resource_link": return content.title ?? content.name ?? content.uri;
		case "resource": return extractResourceText(content);
		case "audio": return `[audio] ${content.mimeType}`;
		default: return;
	}
}
function extractResourceText(content) {
	return "text" in content.resource && typeof content.resource.text === "string" ? content.resource.text : content.resource.uri;
}
function contentToUserContent(content) {
	if (content.type === "text") return { Text: content.text };
	if (content.type === "resource_link") {
		const value = content.title ?? content.name ?? content.uri;
		return { Mention: {
			uri: content.uri,
			content: value
		} };
	}
	if (content.type === "resource") return resourceToUserContent(content);
	if (content.type === "image") return { Image: {
		source: content.data,
		size: null
	} };
	if (content.type === "audio") return { Audio: {
		source: content.data,
		mime_type: content.mimeType
	} };
}
function resourceToUserContent(content) {
	if ("text" in content.resource && typeof content.resource.text === "string") return { Text: content.resource.text };
	return { Mention: {
		uri: content.resource.uri,
		content: content.resource.uri
	} };
}
function nextUserMessageId() {
	return randomUUID();
}
function isUserMessage(message) {
	return typeof message === "object" && message !== null && hasOwn(message, "User");
}
function isAgentMessage(message) {
	return typeof message === "object" && message !== null && hasOwn(message, "Agent");
}
function isAgentTextContent(content) {
	return hasOwn(content, "Text");
}
function isAgentThinkingContent(content) {
	return hasOwn(content, "Thinking");
}
function isAgentToolUseContent(content) {
	return hasOwn(content, "ToolUse");
}
function updateConversationTimestamp(conversation, timestamp) {
	conversation.updated_at = timestamp;
}
function ensureAgentMessage(conversation) {
	const last = conversation.messages.at(-1);
	if (last && isAgentMessage(last)) return last.Agent;
	const created = {
		content: [],
		tool_results: {}
	};
	conversation.messages.push({ Agent: created });
	return created;
}
function appendAgentText(agent, text) {
	if (!text.trim()) return;
	const last = agent.content.at(-1);
	if (last && isAgentTextContent(last)) {
		last.Text = trimRuntimeText(`${last.Text}${text}`, MAX_RUNTIME_AGENT_TEXT_CHARS);
		return;
	}
	const next = { Text: text };
	agent.content.push(next);
}
function appendAgentThinking(agent, text) {
	if (!text.trim()) return;
	const last = agent.content.at(-1);
	if (last && isAgentThinkingContent(last)) {
		last.Thinking.text = trimRuntimeText(`${last.Thinking.text}${text}`, MAX_RUNTIME_THINKING_CHARS);
		return;
	}
	const next = { Thinking: {
		text,
		signature: null
	} };
	agent.content.push(next);
}
function trimRuntimeText(value, maxChars) {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}
function statusIndicatesComplete(status) {
	if (typeof status !== "string") return false;
	const normalized = status.toLowerCase();
	return normalized.includes("complete") || normalized.includes("done") || normalized.includes("success") || normalized.includes("failed") || normalized.includes("error") || normalized.includes("cancel");
}
function statusIndicatesError(status) {
	if (typeof status !== "string") return false;
	const normalized = status.toLowerCase();
	return normalized.includes("fail") || normalized.includes("error");
}
function toToolResultContent(value) {
	if (typeof value === "string") return { Text: trimRuntimeText(value, MAX_RUNTIME_TOOL_IO_CHARS) };
	if (value != null) try {
		return { Text: trimRuntimeText(JSON.stringify(value), MAX_RUNTIME_TOOL_IO_CHARS) };
	} catch {
		return { Text: "[Unserializable value]" };
	}
	return { Text: "" };
}
function toRawInput(value) {
	if (typeof value === "string") return trimRuntimeText(value, MAX_RUNTIME_TOOL_IO_CHARS);
	try {
		return trimRuntimeText(JSON.stringify(value ?? {}), MAX_RUNTIME_TOOL_IO_CHARS);
	} catch {
		return value == null ? "" : "[Unserializable input]";
	}
}
function ensureToolUseContent(agent, toolCallId) {
	for (const content of agent.content) if (isAgentToolUseContent(content) && content.ToolUse.id === toolCallId) return content.ToolUse;
	const created = {
		id: toolCallId,
		name: "tool_call",
		raw_input: "{}",
		input: {},
		is_input_complete: false,
		thought_signature: null
	};
	agent.content.push({ ToolUse: created });
	return created;
}
function upsertToolResult(agent, toolCallId, patch) {
	const existing = agent.tool_results[toolCallId];
	const fallback = existingToolResultValues(existing);
	const next = {
		tool_use_id: toolCallId,
		tool_name: patch.tool_name ?? fallback.tool_name,
		is_error: patch.is_error ?? fallback.is_error,
		content: patch.content ?? fallback.content,
		output: patch.output ?? fallback.output
	};
	agent.tool_results[toolCallId] = next;
}
function existingToolResultValues(existing) {
	if (existing) return existing;
	return {
		tool_use_id: "",
		tool_name: "tool_call",
		is_error: false,
		content: { Text: "" },
		output: void 0
	};
}
function applyToolCallUpdate(agent, update) {
	const tool = ensureToolUseContent(agent, update.toolCallId);
	applyToolIdentityUpdate(tool, update);
	applyToolInputUpdate(tool, update);
	applyToolStatusUpdate(tool, update);
	applyToolResultUpdate(agent, tool, update);
}
function applyToolIdentityUpdate(tool, update) {
	if (hasOwn(update, "title")) tool.name = normalizeAgentName(update.title) ?? tool.name ?? "tool_call";
	if (hasOwn(update, "kind")) {
		const kindName = normalizeAgentName(update.kind);
		if (!tool.name || tool.name === "tool_call") tool.name = kindName ?? tool.name;
	}
}
function applyToolInputUpdate(tool, update) {
	if (!hasOwn(update, "rawInput")) return;
	const rawInput = deepClone(update.rawInput);
	tool.input = rawInput ?? {};
	tool.raw_input = toRawInput(rawInput);
}
function applyToolStatusUpdate(tool, update) {
	if (hasOwn(update, "status")) tool.is_input_complete = statusIndicatesComplete(update.status);
}
function applyToolResultUpdate(agent, tool, update) {
	if (!hasToolResultPatch(update)) return;
	const status = update.status;
	const output = hasOwn(update, "rawOutput") ? deepClone(update.rawOutput) : void 0;
	upsertToolResult(agent, update.toolCallId, {
		tool_name: tool.name,
		is_error: statusIndicatesError(status),
		content: output === void 0 ? void 0 : toToolResultContent(output),
		output
	});
}
function hasToolResultPatch(update) {
	return [
		"rawOutput",
		"status",
		"title",
		"kind"
	].some((key) => hasOwn(update, key));
}
function asRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return value;
}
function numberField(source, keys) {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	}
}
function sourceToTokenUsage(source) {
	const usageRecord = asRecord(source);
	if (!usageRecord) return;
	const normalized = {
		input_tokens: numberField(usageRecord, ["input_tokens", "inputTokens"]),
		output_tokens: numberField(usageRecord, ["output_tokens", "outputTokens"]),
		cache_creation_input_tokens: numberField(usageRecord, [
			"cache_creation_input_tokens",
			"cacheCreationInputTokens",
			"cachedWriteTokens"
		]),
		cache_read_input_tokens: numberField(usageRecord, [
			"cache_read_input_tokens",
			"cacheReadInputTokens",
			"cachedReadTokens"
		]),
		thought_tokens: numberField(usageRecord, ["thought_tokens", "thoughtTokens"]),
		total_tokens: numberField(usageRecord, ["total_tokens", "totalTokens"])
	};
	if (!hasTokenUsageValue(normalized)) return;
	return normalized;
}
function usageToTokenUsage(update) {
	const updateRecord = asRecord(update);
	const usageMeta = asRecord(updateRecord?._meta)?.usage;
	const source = asRecord(usageMeta) ?? updateRecord;
	if (!source) return;
	return sourceToTokenUsage(source);
}
function hasTokenUsageValue(usage) {
	return Object.values(usage).some((value) => value !== void 0);
}
function usageCost(update) {
	const cost = asRecord(asRecord(update)?.cost);
	if (!cost) return;
	return buildUsageCost(numberField(cost, ["amount"]), stringField(cost.currency));
}
function stringField(value) {
	return typeof value === "string" && value.trim() ? value : void 0;
}
function buildUsageCost(amount, currency) {
	const cost = {
		...amount !== void 0 ? { amount } : {},
		...currency !== void 0 ? { currency } : {}
	};
	return Object.keys(cost).length > 0 ? cost : void 0;
}
function ensureAcpxState$1(state) {
	return state ?? {};
}
function lastUserMessageId(conversation) {
	for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
		const message = conversation.messages[index];
		if (message && isUserMessage(message)) return message.User.id;
	}
}
function createSessionConversation(timestamp = isoNow()) {
	return {
		title: null,
		messages: [],
		updated_at: timestamp,
		cumulative_token_usage: {},
		cumulative_cost: void 0,
		request_token_usage: {}
	};
}
function cloneSessionConversation(conversation) {
	if (!conversation) return createSessionConversation();
	return {
		title: conversation.title,
		messages: deepClone(conversation.messages ?? []),
		updated_at: conversation.updated_at,
		cumulative_token_usage: deepClone(conversation.cumulative_token_usage ?? {}),
		cumulative_cost: cloneUsageCost(conversation.cumulative_cost),
		request_token_usage: deepClone(conversation.request_token_usage ?? {})
	};
}
function cloneUsageCost(cost) {
	return cost ? { ...cost } : void 0;
}
function cloneSessionAcpxState(state) {
	if (!state) return;
	return {
		current_mode_id: state.current_mode_id,
		desired_mode_id: state.desired_mode_id,
		desired_config_options: state.desired_config_options ? { ...state.desired_config_options } : void 0,
		current_model_id: state.current_model_id,
		available_models: state.available_models ? [...state.available_models] : void 0,
		...state.available_model_names ? { available_model_names: { ...state.available_model_names } } : {},
		model_control: state.model_control,
		available_commands: state.available_commands ? state.available_commands.map((command) => ({ ...command })) : void 0,
		config_options: state.config_options ? deepClone(state.config_options) : void 0,
		session_options: cloneSessionOptions(state.session_options)
	};
}
function cloneSessionOptions(options) {
	if (!options) return;
	return {
		model: options.model,
		allowed_tools: options.allowed_tools ? [...options.allowed_tools] : void 0,
		max_turns: options.max_turns,
		...options.system_prompt !== void 0 ? { system_prompt: cloneSystemPromptOption(options.system_prompt) } : {},
		...options.env !== void 0 ? { env: { ...options.env } } : {}
	};
}
function cloneSystemPromptOption(option) {
	return typeof option === "string" ? option : { append: option.append };
}
function recordPromptSubmission(conversation, prompt, timestamp = isoNow(), messageId) {
	const userContent = (typeof prompt === "string" ? textPrompt(prompt) : prompt).map((content) => contentToUserContent(content)).filter((content) => content !== void 0);
	if (userContent.length === 0) return;
	const promptMessageId = messageId ?? nextUserMessageId();
	conversation.messages.push({ User: {
		id: promptMessageId,
		content: userContent.map((content) => {
			if ("Text" in content) return { Text: trimRuntimeText(content.Text, MAX_RUNTIME_AGENT_TEXT_CHARS) };
			return content;
		})
	} });
	updateConversationTimestamp(conversation, timestamp);
	trimConversationForRuntime(conversation);
	return promptMessageId;
}
function agentMessageHasObservedReply(message) {
	return message.content.length > 0 || Object.keys(message.tool_results).length > 0;
}
function hasAgentReplyAfterPrompt(conversation, promptMessageId) {
	let sawPrompt = false;
	for (const message of conversation.messages) {
		if (!sawPrompt) {
			if (isUserMessage(message) && message.User.id === promptMessageId) sawPrompt = true;
			continue;
		}
		if (isAgentMessage(message) && agentMessageHasObservedReply(message.Agent)) return true;
	}
	return false;
}
function recordSessionUpdate(conversation, state, notification, timestamp = isoNow(), userMessageId) {
	const acpx = ensureAcpxState$1(state);
	const update = notification.update;
	applySessionUpdate(conversation, acpx, update, userMessageId);
	updateConversationTimestamp(conversation, timestamp);
	trimConversationForRuntime(conversation);
	return acpx;
}
function recordPromptResponseUsage(conversation, usage, promptMessageId, timestamp = isoNow()) {
	const tokenUsage = sourceToTokenUsage(usage);
	if (!tokenUsage) return false;
	applyTokenUsage(conversation, tokenUsage, promptMessageId);
	updateConversationTimestamp(conversation, timestamp);
	trimConversationForRuntime(conversation);
	return true;
}
function applySessionUpdate(conversation, acpx, update, userMessageId) {
	const handler = SESSION_UPDATE_HANDLERS[update.sessionUpdate];
	handler?.(conversation, acpx, update, userMessageId);
}
const SESSION_UPDATE_HANDLERS = {
	user_message_chunk: (conversation, _acpx, update, userMessageId) => {
		if (update.sessionUpdate === "user_message_chunk") appendUserMessageChunk(conversation, update.content, userMessageId);
	},
	agent_message_chunk: (conversation, _acpx, update) => {
		if (update.sessionUpdate === "agent_message_chunk") appendAgentMessageChunk(conversation, update.content, appendAgentText);
	},
	agent_thought_chunk: (conversation, _acpx, update) => {
		if (update.sessionUpdate === "agent_thought_chunk") appendAgentMessageChunk(conversation, update.content, appendAgentThinking);
	},
	tool_call: (conversation, _acpx, update) => {
		if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") applyToolCallUpdate(ensureAgentMessage(conversation), update);
	},
	tool_call_update: (conversation, _acpx, update) => {
		if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") applyToolCallUpdate(ensureAgentMessage(conversation), update);
	},
	usage_update: (conversation, _acpx, update) => {
		if (update.sessionUpdate === "usage_update") applyUsageUpdate(conversation, update);
	},
	session_info_update: (conversation, _acpx, update) => {
		if (update.sessionUpdate === "session_info_update") applySessionInfoUpdate(conversation, update);
	},
	available_commands_update: (_conversation, acpx, update) => {
		if (update.sessionUpdate === "available_commands_update") acpx.available_commands = update.availableCommands.map((entry) => normalizeAvailableCommand(entry)).filter((entry) => entry !== void 0);
	},
	current_mode_update: (_conversation, acpx, update) => {
		if (update.sessionUpdate === "current_mode_update") acpx.current_mode_id = update.currentModeId;
	},
	config_option_update: (_conversation, acpx, update) => {
		if (update.sessionUpdate === "config_option_update") applyConfigOptionsModelState(acpx, deepClone(update.configOptions));
	}
};
function appendUserMessageChunk(conversation, content, messageId) {
	const userContent = contentToUserContent(content);
	if (!userContent) return;
	conversation.messages.push({ User: {
		id: messageId ?? nextUserMessageId(),
		content: [userContent]
	} });
}
function appendAgentMessageChunk(conversation, content, append) {
	const text = extractText(content);
	if (text) append(ensureAgentMessage(conversation), text);
}
function applyUsageUpdate(conversation, update) {
	const usage = usageToTokenUsage(update);
	const cost = usageCost(update);
	if (!usage && !cost) return;
	if (usage) applyTokenUsage(conversation, usage);
	if (cost) conversation.cumulative_cost = cost;
}
function applyTokenUsage(conversation, usage, promptMessageId) {
	conversation.cumulative_token_usage = usage;
	const userId = promptMessageId ?? lastUserMessageId(conversation);
	if (userId) conversation.request_token_usage[userId] = usage;
}
function applySessionInfoUpdate(conversation, update) {
	if (hasOwn(update, "title")) conversation.title = update.title ?? null;
	if (hasOwn(update, "updatedAt")) conversation.updated_at = update.updatedAt ?? conversation.updated_at;
}
function recordClientOperation(conversation, state, _operation, timestamp = isoNow()) {
	const acpx = ensureAcpxState$1(state);
	updateConversationTimestamp(conversation, timestamp);
	trimConversationForRuntime(conversation);
	return acpx;
}
function trimConversationForRuntime(conversation) {
	if (conversation.messages.length > MAX_RUNTIME_MESSAGES) conversation.messages = conversation.messages.slice(-200);
	for (const message of conversation.messages) trimRuntimeMessage(message);
	const requestUsageEntries = Object.entries(conversation.request_token_usage);
	if (requestUsageEntries.length > MAX_RUNTIME_REQUEST_TOKEN_USAGE) conversation.request_token_usage = Object.fromEntries(requestUsageEntries.slice(-100));
}
function trimRuntimeMessage(message) {
	if (isUserMessage(message)) {
		trimRuntimeUserMessage(message.User);
		return;
	}
	if (isAgentMessage(message)) trimRuntimeAgentMessage(message.Agent);
}
function trimRuntimeUserMessage(message) {
	message.content = message.content.map((content) => {
		if ("Text" in content) return { Text: trimRuntimeText(content.Text, MAX_RUNTIME_AGENT_TEXT_CHARS) };
		return content;
	});
}
function trimRuntimeAgentMessage(message) {
	for (const content of message.content) trimRuntimeAgentContent(content);
	for (const result of Object.values(message.tool_results)) trimRuntimeToolResult(result);
}
function trimRuntimeAgentContent(content) {
	if ("Text" in content) content.Text = trimRuntimeText(content.Text, MAX_RUNTIME_AGENT_TEXT_CHARS);
	else if ("Thinking" in content) content.Thinking.text = trimRuntimeText(content.Thinking.text, MAX_RUNTIME_THINKING_CHARS);
	else if ("ToolUse" in content) content.ToolUse.raw_input = trimRuntimeText(content.ToolUse.raw_input, MAX_RUNTIME_TOOL_IO_CHARS);
}
function trimRuntimeToolResult(result) {
	if ("Text" in result.content) result.content.Text = trimRuntimeText(result.content.Text, MAX_RUNTIME_TOOL_IO_CHARS);
	if (typeof result.output === "string") result.output = trimRuntimeText(result.output, MAX_RUNTIME_TOOL_IO_CHARS);
}
//#endregion
//#region src/runtime/engine/lifecycle.ts
function createInitialSessionRecord(params) {
	const now = (/* @__PURE__ */ new Date()).toISOString();
	return {
		schema: "acpx.session.v1",
		acpxRecordId: params.recordId,
		acpSessionId: params.sessionId,
		agentSessionId: params.agentSessionId,
		agentCommand: params.agentCommand,
		agentArgv: params.agentArgv,
		cwd: params.cwd,
		name: params.name,
		createdAt: now,
		lastUsedAt: now,
		lastSeq: 0,
		eventLog: defaultSessionEventLog(params.recordId),
		closed: false,
		closedAt: void 0,
		...createSessionConversation(now),
		acpx: {}
	};
}
function applyLifecycleSnapshotToRecord(record, snapshot) {
	if (!snapshot) return;
	record.pid = snapshot.running ? snapshot.pid : void 0;
	record.agentStartedAt = snapshot.startedAt;
	if (snapshot.lastExit) {
		record.lastAgentExitCode = snapshot.lastExit.exitCode;
		record.lastAgentExitSignal = snapshot.lastExit.signal;
		record.lastAgentExitAt = snapshot.lastExit.exitedAt;
		record.lastAgentDisconnectReason = snapshot.lastExit.reason;
		return;
	}
	record.lastAgentExitCode = void 0;
	record.lastAgentExitSignal = void 0;
	record.lastAgentExitAt = void 0;
	record.lastAgentDisconnectReason = void 0;
}
function reconcileAgentSessionId(record, agentSessionId) {
	const normalized = normalizeAgentSessionId(agentSessionId);
	if (!normalized) return;
	record.agentSessionId = normalized;
}
function sessionHasAgentMessages(recordOrConversation) {
	return recordOrConversation.messages.some((message) => typeof message === "object" && message !== null && "Agent" in message);
}
function applyConversation(record, conversation) {
	record.title = conversation.title;
	record.updated_at = conversation.updated_at;
	record.messages = conversation.messages;
	record.cumulative_token_usage = conversation.cumulative_token_usage;
	record.cumulative_cost = conversation.cumulative_cost;
	record.request_token_usage = conversation.request_token_usage;
}
//#endregion
//#region src/runtime/engine/session-options.ts
function mergeSessionOptions(preferred, fallback) {
	const merged = { ...fallback };
	assignDefinedOption(merged, "model", preferred?.model);
	assignDefinedOption(merged, "allowedTools", preferred?.allowedTools);
	assignDefinedOption(merged, "maxTurns", preferred?.maxTurns);
	assignDefinedOption(merged, "systemPrompt", preferred?.systemPrompt);
	assignDefinedOption(merged, "env", mergeEnvRecords(fallback?.env, preferred?.env));
	return Object.keys(merged).length > 0 ? merged : void 0;
}
function mergeEnvRecords(fallback, preferred) {
	if (!fallback && !preferred) return;
	return {
		...fallback,
		...preferred
	};
}
function assignDefinedOption(target, key, value) {
	if (value !== void 0) target[key] = value;
}
function persistSessionOptions(record, options) {
	const next = options === void 0 ? void 0 : persistedSessionOptions(options);
	if (next !== void 0) {
		record.acpx = {
			...record.acpx,
			session_options: next
		};
		return;
	}
	if (!record.acpx) return;
	delete record.acpx.session_options;
}
function sessionOptionsFromRecord(record) {
	const stored = record.acpx?.session_options;
	if (!stored) return;
	const sessionOptions = {};
	assignDefinedOption(sessionOptions, "model", nonEmptyString(stored.model));
	assignDefinedOption(sessionOptions, "allowedTools", storedAllowedTools(stored.allowed_tools));
	assignDefinedOption(sessionOptions, "maxTurns", storedMaxTurns(stored.max_turns));
	assignDefinedOption(sessionOptions, "systemPrompt", normalizeSystemPromptOption(stored.system_prompt));
	assignDefinedOption(sessionOptions, "env", storedEnvRecord(stored.env));
	return Object.keys(sessionOptions).length > 0 ? sessionOptions : void 0;
}
function persistedSessionOptions(options) {
	const next = {
		model: nonEmptyString(options.model),
		allowed_tools: Array.isArray(options.allowedTools) ? [...options.allowedTools] : void 0,
		max_turns: typeof options.maxTurns === "number" ? options.maxTurns : void 0,
		system_prompt: normalizeSystemPromptOption(options.systemPrompt),
		env: storedEnvRecord(options.env)
	};
	return hasPersistedSessionOptions(next) ? next : void 0;
}
function hasPersistedSessionOptions(options) {
	return options.model !== void 0 || options.allowed_tools !== void 0 || options.max_turns !== void 0 || options.system_prompt !== void 0 || options.env !== void 0;
}
function storedEnvRecord(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return;
	const entries = Object.entries(value);
	const result = {};
	for (const [key, raw] of entries) {
		if (typeof raw !== "string") continue;
		result[key] = raw;
	}
	return Object.keys(result).length > 0 ? result : void 0;
}
function normalizeSystemPromptOption(value) {
	const prompt = nonEmptyString(value);
	if (prompt !== void 0) return prompt;
	const append = appendedSystemPrompt(value);
	return append === void 0 ? void 0 : { append };
}
function appendedSystemPrompt(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return;
	return nonEmptyString(value.append);
}
function storedAllowedTools(value) {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : void 0;
}
function storedMaxTurns(value) {
	return typeof value === "number" ? value : void 0;
}
function nonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0 ? value : void 0;
}
//#endregion
//#region src/session/mode-preference.ts
function ensureAcpxState(state) {
	return state ?? {};
}
function normalizeModeId(modeId) {
	if (typeof modeId !== "string") return;
	const trimmed = modeId.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function normalizeModelId(modelId) {
	if (typeof modelId !== "string") return;
	const trimmed = modelId.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function getDesiredModeId(state) {
	return normalizeModeId(state?.desired_mode_id);
}
function getDesiredConfigOptions(state) {
	const desired = state?.desired_config_options;
	if (!desired) return {};
	return Object.fromEntries(Object.entries(desired).flatMap(([configId, value]) => {
		const normalizedConfigId = normalizeModeId(configId);
		return normalizedConfigId && typeof value === "string" ? [[normalizedConfigId, value]] : [];
	}));
}
function setDesiredModeId(record, modeId) {
	const acpx = ensureAcpxState(record.acpx);
	const normalized = normalizeModeId(modeId);
	if (normalized) acpx.desired_mode_id = normalized;
	else delete acpx.desired_mode_id;
	record.acpx = acpx;
}
function clearDesiredConfigOption(state, configId) {
	const normalizedConfigId = normalizeModeId(configId);
	if (!normalizedConfigId || !state.desired_config_options) return;
	const desired = { ...state.desired_config_options };
	delete desired[normalizedConfigId];
	if (Object.keys(desired).length > 0) state.desired_config_options = desired;
	else delete state.desired_config_options;
}
function getDesiredModelId(state) {
	return normalizeModelId(state?.session_options?.model);
}
function setCurrentModelId(record, modelId) {
	const acpx = ensureAcpxState(record.acpx);
	const normalized = normalizeModelId(modelId);
	if (normalized) acpx.current_model_id = normalized;
	else delete acpx.current_model_id;
	record.acpx = acpx;
}
function syncAdvertisedModelState(record, models) {
	if (!models) return;
	const acpx = ensureAcpxState(record.acpx);
	applyAdvertisedModelState(acpx, models);
	record.acpx = acpx;
}
//#endregion
//#region src/session/model-application.ts
function currentModelIdFromSetModelResponse(response, fallbackModelId) {
	return modelStateFromConfigOptions(response?.configOptions)?.currentModelId ?? fallbackModelId;
}
async function applyRequestedModelIfAdvertised(params) {
	const requestedModel = typeof params.requestedModel === "string" ? params.requestedModel.trim() : "";
	if (!requestedModel) return { applied: false };
	const warning = assertRequestedModelSupported({
		requestedModel,
		models: params.models,
		agentCommand: params.agentCommand,
		context: "apply"
	});
	if (warning) params.onWarning?.(warning);
	if (!params.models) return { applied: false };
	if (params.models.currentModelId === requestedModel) return { applied: true };
	return {
		applied: true,
		response: await withTimeout(params.client.setSessionModel(params.sessionId, requestedModel, params.models), params.timeoutMs)
	};
}
//#endregion
//#region src/session/config-options.ts
function applyConfigOptionsToState(state, configOptions) {
	const acpxState = cloneSessionAcpxState(state) ?? {};
	applyConfigOptionsModelState(acpxState, configOptions);
	return acpxState;
}
function applyConfigOptionsToRecord(record, result) {
	const configOptions = result?.configOptions;
	if (!configOptions) return;
	record.acpx = applyConfigOptionsToState(record.acpx, configOptions);
}
function applyInitialModelSelection(record, originalModels, requestedModel, modelApplication) {
	applyConfigOptionsToRecord(record, modelApplication.response);
	syncAdvertisedModelState(record, modelApplication.response ? modelStateFromConfigOptions(modelApplication.response.configOptions) : originalModels);
	if (modelApplication.applied) setCurrentModelId(record, currentModelIdFromSetModelResponse(modelApplication.response, requestedModel));
}
function applyAcceptedConfigOptions(state, response) {
	const next = cloneSessionAcpxState(state) ?? {};
	if (!response) return next;
	applyConfigOptionsModelState(next, response.configOptions);
	if (!next.desired_config_options) return next;
	const desired = {};
	for (const option of response.configOptions) if (typeof option.currentValue === "string" && Object.hasOwn(next.desired_config_options, option.id)) desired[option.id] = option.currentValue;
	if (Object.keys(desired).length > 0) next.desired_config_options = desired;
	else delete next.desired_config_options;
	return next;
}
function applyModelSelection(state, modelId, response) {
	const modelConfigId = advertisedModelState(state)?.configId;
	const next = applyAcceptedConfigOptions(state, response);
	next.session_options = {
		...next.session_options,
		model: modelId
	};
	next.current_model_id = currentModelIdFromSetModelResponse(response, modelId);
	clearDesiredConfigOption(next, modelConfigId ?? advertisedModelState(next)?.configId);
	return next;
}
function applyConfigOptionSelection(state, configId, value, response, modelConfigId = advertisedModelState(state)?.configId) {
	if (configId === modelConfigId || configId === modelStateFromConfigOptions(response.configOptions)?.configId) return applyModelSelection(state, value, response);
	const next = cloneSessionAcpxState(state) ?? {};
	if (configId === "mode") next.desired_mode_id = value;
	else next.desired_config_options = {
		...next.desired_config_options,
		[configId]: value
	};
	return applyAcceptedConfigOptions(next, response);
}
//#endregion
//#region src/runtime/engine/reconnect.ts
const SESSION_LOAD_UNSUPPORTED_CODES = /* @__PURE__ */ new Set([-32601, -32602]);
function shouldFallbackToNewSession(error, record) {
	if (isHardReconnectFailure(error)) return false;
	const acp = extractAcpError(error);
	if (isAcpResourceNotFoundError(error) || isUnsupportedSessionLoadAcpError(acp)) return true;
	return !sessionHasAgentMessages(record) && isFallbackSafeEmptySessionError(error, acp);
}
function isHardReconnectFailure(error) {
	return error instanceof TimeoutError || error instanceof InterruptedError;
}
function isUnsupportedSessionLoadAcpError(acp) {
	return !!acp && SESSION_LOAD_UNSUPPORTED_CODES.has(acp.code);
}
function isFallbackSafeEmptySessionError(error, acp) {
	return isAcpQueryClosedBeforeResponseError(error) || acp?.code === -32603;
}
function requiresSameSession(resumePolicy) {
	return resumePolicy === "same-session-only";
}
function makeSessionResumeRequiredError(params) {
	return new SessionResumeRequiredError(`Persistent ACP session ${params.record.acpSessionId} could not be resumed: ${params.reason}`, { cause: params.cause instanceof Error ? params.cause : void 0 });
}
async function replayDesiredMode(params) {
	if (!params.desiredModeId) return;
	try {
		await withTimeout(params.client.setSessionMode(params.sessionId, params.desiredModeId), params.timeoutMs);
		if (params.verbose) process.stderr.write(`[acpx] replayed desired mode ${params.desiredModeId} on fresh ACP session ${params.sessionId} (previous ${params.previousSessionId})\n`);
	} catch (error) {
		throw new SessionModeReplayError(`Failed to replay saved session mode ${params.desiredModeId} on fresh ACP session ${params.sessionId}: ${formatErrorMessage(error)}`, {
			cause: error instanceof Error ? error : void 0,
			retryable: true
		});
	}
}
function canReplayModel(desiredModelId, models, createdFreshSession) {
	return Boolean(desiredModelId) && (createdFreshSession || models !== void 0);
}
async function replayDesiredModel(params) {
	if (!canReplayModel(params.desiredModelId, params.models, params.createdFreshSession)) return { replayed: false };
	try {
		emitModelSupportWarning(assertRequestedModelSupported({
			requestedModel: params.desiredModelId,
			models: params.models,
			agentCommand: params.record.agentCommand,
			context: "replay"
		}), params.suppressWarnings);
		if (!params.models) return { replayed: false };
		const response = await withTimeout(params.client.setSessionModel(params.sessionId, params.desiredModelId, params.models), params.timeoutMs);
		params.record.acpx = applyModelSelection(params.record.acpx, params.desiredModelId, response);
		const models = response ? modelStateFromConfigOptions(response.configOptions) : {
			...params.models,
			currentModelId: params.desiredModelId
		};
		if (params.verbose) process.stderr.write(`[acpx] replayed desired model ${params.desiredModelId} on ACP session ${params.sessionId} (previous ${params.previousSessionId})\n`);
		return {
			replayed: true,
			models,
			configOptions: response?.configOptions
		};
	} catch (error) {
		throw new SessionModelReplayError(`Failed to replay saved session model ${params.desiredModelId} on ACP session ${params.sessionId}: ${formatErrorMessage(error)}`, {
			cause: error instanceof Error ? error : void 0,
			retryable: true
		});
	}
}
function emitModelSupportWarning(warning, suppressWarnings) {
	if (warning && !suppressWarnings) process.stderr.write(`[acpx] warning: ${warning}\n`);
}
async function replayDesiredConfigOptions(params) {
	let result = { replayed: false };
	let acceptedConfigOptions = params.acceptedConfigOptions;
	const replacingKey = resolveReplacingConfigOptionId(params.replacingConfigOption, params.record);
	for (const [configId, value] of Object.entries(params.desiredConfigOptions)) {
		if (configId === replacingKey || acceptedConfigOptions && !acceptsSavedConfigValue(acceptedConfigOptions.find((option) => option.id === configId), value)) continue;
		try {
			const response = await withTimeout(params.client.setSessionConfigOption(params.sessionId, configId, value), params.timeoutMs);
			params.record.acpx = applyConfigOptionSelection(params.record.acpx, configId, value, response);
			acceptedConfigOptions = response.configOptions;
			result = {
				replayed: true,
				models: modelStateFromConfigOptions(response.configOptions)
			};
			if (params.verbose) process.stderr.write(`[acpx] replayed desired config option ${configId} on ACP session ${params.sessionId} (previous ${params.previousSessionId})\n`);
		} catch (error) {
			throw new SessionConfigOptionReplayError(`Failed to replay saved session config option ${configId} on ACP session ${params.sessionId}: ${formatErrorMessage(error)}`, {
				cause: error instanceof Error ? error : void 0,
				retryable: true
			});
		}
	}
	return result;
}
function restoreOriginalSessionState(params) {
	params.record.acpSessionId = params.sessionId;
	params.record.agentSessionId = params.agentSessionId;
}
async function connectAndLoadSession(options) {
	const record = options.record;
	const client = options.client;
	const sameSessionOnly = requiresSameSession(options.resumePolicy) || Boolean(record.importedFrom);
	const originalSessionId = record.acpSessionId;
	const originalAgentSessionId = record.agentSessionId;
	const originalAcpx = cloneSessionAcpxState(record.acpx);
	const desiredModeId = getDesiredModeId(record.acpx);
	const desiredModelId = getDesiredModelId(record.acpx);
	const desiredConfigOptions = getDesiredConfigOptions(record.acpx);
	const storedProcessAlive = isProcessAlive(record.pid);
	logReconnectAttempt(record, storedProcessAlive, Boolean(record.pid) && !storedProcessAlive, options.verbose);
	const reusingLoadedSession = client.hasReusableSession(record.acpSessionId);
	if (reusingLoadedSession) incrementPerfCounter("runtime.connect_and_load.reused_session");
	else await withTimeout(client.start(), options.timeoutMs);
	options.onClientAvailable?.(options.activeController);
	applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
	record.closed = false;
	record.closedAt = void 0;
	options.onConnectedRecord?.(record);
	const loadState = await loadOrCreateRuntimeSession({
		client,
		record,
		reusingLoadedSession,
		sameSessionOnly,
		timeoutMs: options.timeoutMs
	});
	const { resumed, loadError, sessionId, createdFreshSession, pendingAgentSessionId, sessionModels } = loadState;
	const preferenceReplay = await replaySessionPreferences({
		client,
		record,
		createdFreshSession,
		reusingLoadedSession,
		replacingConfigOption: options.replacingConfigOption,
		sessionId,
		pendingAgentSessionId,
		originalSessionId,
		originalAgentSessionId,
		originalAcpx,
		desiredModeId,
		desiredModelId,
		desiredConfigOptions,
		sessionModels,
		timeoutMs: options.timeoutMs,
		verbose: options.verbose,
		suppressWarnings: options.suppressWarnings
	});
	applyReconnectedModelState(record, resolveModelsAfterReplay(preferenceReplay, sessionModels), resolveConfigOptionsPresenceAfterReplay(preferenceReplay, loadState.configOptionsPresent), loadState.legacyModelMetadataPresent, createdFreshSession);
	options.onSessionIdResolved?.(sessionId);
	return {
		sessionId,
		agentSessionId: record.agentSessionId,
		resumed,
		loadError
	};
}
function resolveModelsAfterReplay(replay, initialModels) {
	if (replay.configReplay.replayed) return replay.configReplay.models ?? preserveLegacyModels(replay.modelReplay.replayed ? replay.modelReplay.models : initialModels);
	return replay.modelReplay.replayed ? replay.modelReplay.models : initialModels;
}
function preserveLegacyModels(models) {
	return models && !models.configId ? models : void 0;
}
function resolveConfigOptionsPresenceAfterReplay(replay, initiallyPresent) {
	return initiallyPresent || replay.configReplay.replayed || replay.modelReplay.configOptions !== void 0;
}
function applyReconnectedModelState(record, sessionModels, configOptionsPresent, legacyModelMetadataPresent, createdFreshSession) {
	clearOmittedFreshSessionConfigOptions(record, createdFreshSession, configOptionsPresent);
	if (sessionModels) {
		if (legacyModelMetadataPresent && !sessionModels.configId && record.acpx) removeModelConfigOptions(record.acpx);
		syncAdvertisedModelState(record, sessionModels);
	} else clearRemovedModelState(record, legacyModelMetadataPresent || createdFreshSession);
}
function clearOmittedFreshSessionConfigOptions(record, createdFreshSession, configOptionsPresent) {
	if (createdFreshSession && !configOptionsPresent && record.acpx) delete record.acpx.config_options;
}
function clearRemovedModelState(record, shouldClear) {
	if (shouldClear && record.acpx) clearAdvertisedModelState(record.acpx);
}
function logReconnectAttempt(record, storedProcessAlive, shouldReconnect, verbose) {
	if (!verbose) return;
	if (storedProcessAlive) {
		process.stderr.write(`[acpx] saved session pid ${record.pid} is running; reconnecting to saved ACP session\n`);
		return;
	}
	if (shouldReconnect) process.stderr.write(`[acpx] saved session pid ${record.pid} is dead; respawning agent and attempting session reconnect\n`);
}
function replacesModel(replacingConfigOption, models, originalAcpx) {
	const key = replacingConfigOption?.key;
	return key !== void 0 && (key === "model" || key === models?.configId || key === advertisedModelState(originalAcpx)?.configId);
}
function acceptsSavedConfigValue(option, value) {
	if (!option || option.type !== "select") return false;
	return option.currentValue === value || option.options.some((entry) => "options" in entry ? entry.options.some((choice) => choice.value === value) : entry.value === value);
}
function resolveReplacingConfigOptionId(replacement, record) {
	return replacement?.resolve?.(record) ?? replacement?.key;
}
async function replaySessionPreferences(params) {
	if (params.reusingLoadedSession) return {
		modelReplay: { replayed: false },
		configReplay: { replayed: false }
	};
	let modelReplay = { replayed: false };
	let configReplay = { replayed: false };
	const replacingModel = replacesModel(params.replacingConfigOption, params.sessionModels, params.originalAcpx);
	try {
		await replayDesiredMode({
			client: params.client,
			sessionId: params.sessionId,
			desiredModeId: params.createdFreshSession ? params.desiredModeId : void 0,
			previousSessionId: params.originalSessionId,
			timeoutMs: params.timeoutMs,
			verbose: params.verbose
		});
		modelReplay = await replayDesiredModel({
			client: params.client,
			sessionId: params.sessionId,
			desiredModelId: replacingModel ? void 0 : params.desiredModelId,
			previousSessionId: params.originalSessionId,
			record: params.record,
			models: params.sessionModels,
			createdFreshSession: params.createdFreshSession,
			timeoutMs: params.timeoutMs,
			verbose: params.verbose,
			suppressWarnings: params.suppressWarnings
		});
		configReplay = await replayDesiredConfigOptions({
			client: params.client,
			record: params.record,
			sessionId: params.sessionId,
			desiredConfigOptions: replacingModel ? {} : params.desiredConfigOptions,
			acceptedConfigOptions: modelReplay.configOptions,
			replacingConfigOption: replacingModel ? void 0 : params.replacingConfigOption,
			previousSessionId: params.originalSessionId,
			timeoutMs: params.timeoutMs,
			verbose: params.verbose
		});
	} catch (error) {
		restoreOriginalSessionState({
			record: params.record,
			sessionId: params.originalSessionId,
			agentSessionId: params.originalAgentSessionId
		});
		params.record.acpx = cloneSessionAcpxState(params.originalAcpx);
		if (params.verbose) process.stderr.write(`[acpx] ${formatErrorMessage(error)}\n`);
		throw error;
	}
	params.record.acpSessionId = params.sessionId;
	reconcileAgentSessionId(params.record, params.pendingAgentSessionId);
	return {
		modelReplay,
		configReplay
	};
}
async function loadOrCreateRuntimeSession(params) {
	if (params.reusingLoadedSession) return {
		sessionId: params.record.acpSessionId,
		pendingAgentSessionId: params.record.agentSessionId,
		sessionModels: void 0,
		configOptionsPresent: false,
		legacyModelMetadataPresent: false,
		resumed: true,
		createdFreshSession: false
	};
	if (params.client.supportsResumeSession()) return await loadRuntimeSession(params, true);
	if (params.client.supportsLoadSession()) return await loadRuntimeSession(params, false);
	if (params.sameSessionOnly) throw makeSessionResumeRequiredError({
		record: params.record,
		reason: "agent does not support session/resume or session/load"
	});
	return await createFreshRuntimeSession(params.client, params.record, params.timeoutMs);
}
async function loadRuntimeSession(params, resume) {
	try {
		const loadResult = await withTimeout(resume ? params.client.resumeSession(params.record.acpSessionId, params.record.cwd) : params.client.loadSessionWithOptions(params.record.acpSessionId, params.record.cwd, { suppressReplayUpdates: true }), params.timeoutMs);
		reconcileAgentSessionId(params.record, loadResult.agentSessionId);
		applyConfigOptionsToRecord(params.record, loadResult);
		return {
			sessionId: params.record.acpSessionId,
			pendingAgentSessionId: params.record.agentSessionId,
			sessionModels: loadResult.models,
			configOptionsPresent: loadResult.configOptionsPresent,
			legacyModelMetadataPresent: loadResult.legacyModelMetadataPresent,
			resumed: true,
			createdFreshSession: false
		};
	} catch (error) {
		return await recoverRuntimeSessionLoadFailure(params, error);
	}
}
async function recoverRuntimeSessionLoadFailure(params, error) {
	const loadError = formatErrorMessage(error);
	if (params.sameSessionOnly) throw makeSessionResumeRequiredError({
		record: params.record,
		reason: loadError,
		cause: error
	});
	if (!shouldFallbackToNewSession(error, params.record)) throw error;
	return {
		...await createFreshRuntimeSession(params.client, params.record, params.timeoutMs),
		loadError
	};
}
async function createFreshRuntimeSession(client, record, timeoutMs) {
	const createdSession = await withTimeout(client.createSession(record.cwd), timeoutMs);
	applyConfigOptionsToRecord(record, createdSession);
	return {
		sessionId: createdSession.sessionId,
		pendingAgentSessionId: createdSession.agentSessionId,
		sessionModels: createdSession.models,
		configOptionsPresent: createdSession.configOptionsPresent,
		legacyModelMetadataPresent: createdSession.legacyModelMetadataPresent,
		resumed: false,
		createdFreshSession: true
	};
}
//#endregion
//#region src/runtime/engine/connected-session.ts
function createActiveSessionController(params) {
	const getActiveSessionId = () => params.getActiveSessionId();
	return {
		hasActivePrompt: () => params.client.hasActivePrompt(),
		requestCancelActivePrompt: async () => await params.client.requestCancelActivePrompt(),
		setSessionMode: async (modeId) => {
			await params.client.setSessionMode(getActiveSessionId(), modeId);
		},
		setSessionModel: async (modelId) => {
			const models = advertisedModelState(params.record.acpx);
			const response = await params.client.setSessionModel(getActiveSessionId(), modelId, models);
			applyConfigOptionsToRecord(params.record, response);
			return response;
		},
		setSessionConfigOption: async (configId, value) => {
			return await params.client.setSessionConfigOption(getActiveSessionId(), configId, value);
		}
	};
}
async function withConnectedSession(options) {
	const record = await options.loadRecord(options.sessionRecordId);
	const clientOptions = {
		agentCommand: record.agentCommand,
		agentArgv: record.agentArgv,
		cwd: absolutePath(record.cwd),
		mcpServers: options.mcpServers,
		permissionMode: options.permissionMode ?? "approve-reads",
		nonInteractivePermissions: options.nonInteractivePermissions,
		permissionPolicy: options.permissionPolicy,
		onPermissionRequest: options.onPermissionRequest,
		authCredentials: options.authCredentials,
		authPolicy: options.authPolicy,
		fs: options.fs,
		terminal: options.terminal,
		elicitationModes: options.elicitationModes,
		verbose: options.verbose,
		sessionOptions: sessionOptionsFromRecord(record)
	};
	const client = options.createClient?.(clientOptions) ?? new AcpClient(clientOptions);
	let activeSessionIdForControl = record.acpSessionId;
	let notifiedClientAvailable = false;
	const activeController = createActiveSessionController({
		client,
		record,
		getActiveSessionId: () => activeSessionIdForControl
	});
	try {
		return await withInterrupt(async () => {
			const { sessionId, resumed, loadError } = await connectAndLoadSession({
				client,
				record,
				resumePolicy: options.resumePolicy,
				replacingConfigOption: options.replacingConfigOption,
				timeoutMs: options.timeoutMs,
				verbose: options.verbose,
				activeController,
				onClientAvailable: (controller) => {
					options.onClientAvailable?.(controller);
					notifiedClientAvailable = true;
				},
				onConnectedRecord: options.onConnectedRecord,
				onSessionIdResolved: (sessionIdValue) => {
					activeSessionIdForControl = sessionIdValue;
				}
			});
			const value = await options.run({
				record,
				client,
				activeController,
				sessionId,
				resumed,
				loadError
			});
			const now = isoNow$1();
			record.lastUsedAt = now;
			record.closed = false;
			record.closedAt = void 0;
			record.protocolVersion = client.initializeResult?.protocolVersion;
			record.agentCapabilities = client.initializeResult?.agentCapabilities;
			applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
			await options.saveRecord(record);
			return {
				value,
				record,
				resumed,
				loadError
			};
		}, async () => {
			if (options.onInterrupt) await options.onInterrupt({
				client,
				record
			});
			else await client.cancelActivePrompt(2500);
			applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
			record.lastUsedAt = isoNow$1();
			await options.saveRecord(record).catch(() => {});
			await client.close();
		});
	} finally {
		if (notifiedClientAvailable) options.onClientClosed?.();
		await client.close();
		applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
		await options.saveRecord(record).catch(() => {});
	}
}
//#endregion
//#region src/runtime/engine/prompt-turn.ts
const SESSION_REPLY_IDLE_MS = 1e3;
const SESSION_REPLY_DRAIN_TIMEOUT_MS = 5e3;
function responseMetaField(meta) {
	return meta === void 0 ? {} : { _meta: meta };
}
function recoveredSessionResult(response, conversation, promptMessageId) {
	recordPromptResponseUsage(conversation, response?.usage, promptMessageId);
	return {
		stopReason: "end_turn",
		source: "session",
		...responseMetaField(response?._meta)
	};
}
function abortTimedOutRequests(error, client, sessionId) {
	if (error instanceof TimeoutError) client.endPromptElicitation?.(sessionId);
}
async function runPromptTurn(params) {
	let settledResponse;
	try {
		const promptPromise = params.client.prompt(params.sessionId, params.prompt, params.onPromptRequestWritten, params.onElicitation, params.onPermissionRequest);
		promptPromise.then((response) => {
			settledResponse = response;
		}, () => {});
		await params.onPromptStarted?.();
		const response = await withTimeout(promptPromise, params.timeoutMs);
		await params.client.waitForSessionUpdatesIdle?.({
			idleMs: SESSION_REPLY_IDLE_MS,
			timeoutMs: SESSION_REPLY_DRAIN_TIMEOUT_MS
		}).catch(() => {});
		recordPromptResponseUsage(params.conversation, response.usage, params.promptMessageId);
		return {
			stopReason: response.stopReason,
			source: "rpc",
			...responseMetaField(response._meta)
		};
	} catch (error) {
		abortTimedOutRequests(error, params.client, params.sessionId);
		if (!(error instanceof TimeoutError) || !params.promptMessageId) throw error;
		await params.client.waitForSessionUpdatesIdle?.({
			idleMs: SESSION_REPLY_IDLE_MS,
			timeoutMs: SESSION_REPLY_DRAIN_TIMEOUT_MS
		}).catch(() => {});
		if (hasAgentReplyAfterPrompt(params.conversation, params.promptMessageId)) return recoveredSessionResult(settledResponse, params.conversation, params.promptMessageId);
		throw error;
	}
}
//#endregion
//#region src/session/live-checkpoint.ts
const DEFAULT_LIVE_CHECKPOINT_INTERVAL_MS = 500;
var LiveSessionCheckpoint = class {
	save;
	intervalMs;
	onError;
	dirty = false;
	flushing;
	timer;
	constructor(options) {
		this.save = options.save;
		this.intervalMs = options.intervalMs ?? DEFAULT_LIVE_CHECKPOINT_INTERVAL_MS;
		this.onError = options.onError;
	}
	request() {
		this.dirty = true;
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = void 0;
			this.flush().catch((error) => {
				this.onError?.(error);
			});
		}, this.intervalMs);
		this.timer.unref?.();
	}
	async checkpoint() {
		this.dirty = true;
		await this.flush();
	}
	async flush() {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = void 0;
		}
		if (this.flushing) {
			await this.flushing;
			if (!this.dirty) return;
		}
		this.flushing = this.flushDirty();
		try {
			await this.flushing;
		} finally {
			this.flushing = void 0;
		}
	}
	async flushDirty() {
		while (this.dirty) {
			this.dirty = false;
			await this.save();
		}
	}
};
//#endregion
export { getPerfMetricsSnapshot as $, isRequestedModelUnsupportedError as A, isRetryablePromptError as At, absolutePath as B, OUTPUT_FORMATS as Bt, recordSessionUpdate as C, isLegacyZedCodexAcpInvocation as Ct, REQUESTED_MODEL_UNSUPPORTED_ERROR_CODE as D, withTimeout as Dt, AcpClient as E, withInterrupt as Et, parsePromptSource as F, AUTH_POLICIES as Ft, listSessions as G, AgentSpawnError as Gt, findSession as H, PERMISSION_POLICY_ACTIONS as Ht, promptToDisplayText as I, EXIT_CODES as It, pruneSessions as J, listSessionsForAgent as K, QueueConnectionError as Kt, textPrompt as L, NON_INTERACTIVE_PERMISSION_POLICIES as Lt, PromptInputValidationError as M, extractAcpError as Mt, isPromptInput as N, isAcpResourceNotFoundError as Nt, REQUESTED_MODEL_UNSUPPORTED_REASONS as O, exitCodeForOutputErrorCode as Ot, mergePromptSourceWithText as P, toAcpErrorPayload as Pt, formatPerfMetric as Q, permissionModeSatisfies as R, OUTPUT_ERROR_CODES as Rt, recordPromptSubmission as S, parsePromptStopReason as St, advertisedModelState as T, TimeoutError as Tt, findSessionByDirectoryWalk as U, SESSION_RECORD_SCHEMA as Ut, findGitRepositoryRoot as V, PERMISSION_MODES as Vt, isoNow$1 as W, AcpxOperationalError as Wt, writeSessionRecord as X, resolveSessionRecord as Y, assertPersistedKeyPolicy as Z, reconcileAgentSessionId as _, isProcessAlive as _t, applyConfigOptionSelection as a, startPerfTimer as at, createSessionConversation as b, parseJsonRpcErrorMessage as bt, applyModelSelection as c, normalizeAgentSessionId as ct, mergeSessionOptions as d, sessionBaseDir as dt, incrementPerfCounter as et, persistSessionOptions as f, sessionEventActivePath as ft, createInitialSessionRecord as g, writePrivateJsonFile as gt, applyLifecycleSnapshotToRecord as h, writePrivateFile as ht, connectAndLoadSession as i, setPerfGauge as it, getAcpxVersion as j, normalizeOutputError as jt, RequestedModelUnsupportedError as k, formatErrorMessage as kt, applyRequestedModelIfAdvertised as l, DEFAULT_EVENT_SEGMENT_MAX_BYTES as lt, applyConversation as m, sessionEventSegmentPath as mt, runPromptTurn as n, recordPerfDuration as nt, applyConfigOptionsToRecord as o, parseSessionRecord as ot, sessionOptionsFromRecord as p, sessionEventLockPath as pt, normalizeName as q, QueueProtocolError as qt, withConnectedSession as r, resetPerfMetrics as rt, applyInitialModelSelection as s, serializeSessionRecordForDisk as st, LiveSessionCheckpoint as t, measurePerf as tt, setDesiredModeId as u, defaultSessionEventLog as ut, cloneSessionAcpxState as v, extractSessionUpdateNotification as vt, trimConversationForRuntime as w, InterruptedError as wt, recordClientOperation as x, parsePermissionNotice as xt, cloneSessionConversation as y, isAcpJsonRpcMessage as yt, DEFAULT_HISTORY_LIMIT as z, OUTPUT_ERROR_ORIGINS as zt };

//# sourceMappingURL=live-checkpoint-BEfxBKCh.js.map