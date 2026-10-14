import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { JevSettingsDto } from "@ganglion/xacpx-relay-protocol";

import { ConversationError } from "./conversation-error";
import { DEFAULT_JEV_ENDPOINT, DEFAULT_JEV_MODEL, maskJevKey, maskProxyUrl } from "./jev-client";
import { withPrivateFileLock } from "../util/private-file";

/**
 * Daemon-side Jev settings store.
 *
 * The API key is a secret, so it lives in a dedicated file next to the daemon
 * config (`~/.xacpx/jev.json`), NEVER in config.json (which is logged in doctor
 * output and copied into bug reports). Every write is atomic at mode 0600 via
 * the private-file lock. The key is never logged and never returned in
 * plaintext: readers get `keyConfigured` plus a masked preview.
 *
 * Patch semantics (mirrors the wire payload):
 * - `endpoint` / `proxyUrl`: a string replaces; `proxyUrl: null` removes the
 *   override (empty = daemon process `HTTPS_PROXY` fallback);
 * - `apiKey`: a string sets, `null` clears, omitted keeps.
 */

/** The persisted file shape. Every key is optional: absent means "not
 *  configured", which is distinct from an empty value. */
export interface JevSettingsFile {
  endpoint?: string;
  proxyUrl?: string;
  apiKey?: string;
  model?: string;
}

/** One settings patch. `null` removes the key; omitted keeps the stored value. */
export interface JevSettingsPatch {
  endpoint?: string;
  proxyUrl?: string | null;
  apiKey?: string | null;
}

const FILE_NAME = "jev.json";

/** Absolute path of the secrets file that sits beside `configPath`. */
export function resolveJevSettingsPath(configPath: string): string {
  return join(dirname(configPath), FILE_NAME);
}

function invalid(message: string): ConversationError {
  return new ConversationError("jev_settings_invalid", message);
}

/** http/https only; a bare host or a file path is a configuration mistake that
 *  must fail here rather than at request time. */
function assertUrl(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw invalid(`${field} must not be empty`);
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw invalid(`${field} must be an http(s) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalid(`${field} must use the http or https scheme`);
  }
  return trimmed;
}

export class JevSettingsStore {
  constructor(private readonly path: string) {}

  /** Read the persisted file. A missing file is the empty settings; a corrupt
   *  file fails closed rather than silently dropping a stored key. */
  async read(): Promise<JevSettingsFile> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new ConversationError("jev_settings_unreadable", "the Jev settings file could not be read");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new ConversationError("jev_settings_unreadable", "the Jev settings file is not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ConversationError("jev_settings_unreadable", "the Jev settings file must contain an object");
    }
    const raw = parsed as Record<string, unknown>;
    const settings: JevSettingsFile = {};
    if (typeof raw.endpoint === "string") settings.endpoint = raw.endpoint;
    if (typeof raw.proxyUrl === "string") settings.proxyUrl = raw.proxyUrl;
    if (typeof raw.apiKey === "string") settings.apiKey = raw.apiKey;
    if (typeof raw.model === "string") settings.model = raw.model;
    return settings;
  }

  /** The settings as the wire reports them: effective endpoint/model, the
   *  proxy override only when set, and the key strictly masked. */
  async view(): Promise<JevSettingsDto> {
    const stored = await this.read();
    return {
      endpoint: stored.endpoint ?? DEFAULT_JEV_ENDPOINT,
      ...(stored.proxyUrl !== undefined ? { proxyUrl: maskProxyUrl(stored.proxyUrl) ?? "" } : {}),
      model: stored.model ?? DEFAULT_JEV_MODEL,
      keyConfigured: typeof stored.apiKey === "string" && stored.apiKey.length > 0,
      keyMasked: maskJevKey(stored.apiKey),
    };
  }

  /** Apply one patch under the private-file lock and return the new view. The
   *  whole read→merge→write span is locked, so two concurrent updates cannot
   *  erase each other (same rule as ConfigStore). */
  async update(patch: JevSettingsPatch): Promise<JevSettingsDto> {
    const nextEndpoint = patch.endpoint === undefined ? undefined : assertUrl(patch.endpoint, "endpoint");
    let nextProxy: string | undefined;
    let clearProxy = false;
    if (patch.proxyUrl !== undefined) {
      if (patch.proxyUrl === null) clearProxy = true;
      else nextProxy = assertUrl(patch.proxyUrl, "proxyUrl");
    }
    let nextKey: string | undefined;
    let clearKey = false;
    if (patch.apiKey !== undefined) {
      if (patch.apiKey === null) clearKey = true;
      else {
        const key = patch.apiKey.trim();
        if (key.length === 0) throw invalid("apiKey must not be empty");
        nextKey = key;
      }
    }
    await withPrivateFileLock(this.path, async (writeLocked) => {
      const stored = await this.read();
      const merged: JevSettingsFile = { ...stored };
      if (nextEndpoint !== undefined) merged.endpoint = nextEndpoint;
      if (clearProxy) delete merged.proxyUrl;
      // The wire only ever shows a credential-masked proxy URL; a client that
      // echoes that masked value back unchanged must not overwrite the real one.
      else if (nextProxy !== undefined && !(stored.proxyUrl !== undefined
        && nextProxy !== stored.proxyUrl && nextProxy === maskProxyUrl(stored.proxyUrl))) {
        merged.proxyUrl = nextProxy;
      }
      if (clearKey) delete merged.apiKey;
      else if (nextKey !== undefined) merged.apiKey = nextKey;
      await writeLocked(`${JSON.stringify(merged, null, 2)}\n`);
    });
    return await this.view();
  }
}
