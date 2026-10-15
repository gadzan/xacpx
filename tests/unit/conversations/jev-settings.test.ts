import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JevSettingsStore, resolveJevSettingsPath } from "../../../src/conversations/jev-settings-store";

function store(): { dir: string; store: JevSettingsStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-jev-settings-"));
  const configPath = join(dir, "config.json");
  const path = resolveJevSettingsPath(configPath);
  return { dir, store: new JevSettingsStore(path), path };
}

test("the secrets file sits beside the config", () => {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-jev-path-"));
  try {
    expect(resolveJevSettingsPath(join(dir, "config.json"))).toBe(join(dir, "jev.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing file reads as empty settings with the pinned defaults", async () => {
  const { dir, store: settings } = store();
  try {
    expect(await settings.read()).toEqual({});
    expect(await settings.view()).toEqual({
      endpoint: "https://api.typesafe.ai/v1/systemone",
      model: "jev-1.13.0",
      keyConfigured: false,
      keyMasked: null,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the settings file is written atomically at mode 0600", async () => {
  const { dir, store: settings, path } = store();
  try {
    await settings.update({ apiKey: "sk-1234567890abcd" });
    expect((statSync(path).mode & 0o777).toString(8)).toBe("600");
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(onDisk.apiKey).toBe("sk-1234567890abcd");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the view masks the key and never returns it in plaintext", async () => {
  const { dir, store: settings } = store();
  try {
    await settings.update({ apiKey: "sk-1234567890abcd" });
    const view = await settings.view();
    expect(view.keyConfigured).toBe(true);
    expect(view.keyMasked).toBe("sk-…abcd");
    expect(JSON.stringify(view)).not.toContain("sk-1234567890abcd");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a patch sets, keeps, and clears each key independently", async () => {
  const { dir, store: settings } = store();
  try {
    await settings.update({ endpoint: "https://proxy.example/v1", apiKey: "sk-abcdefgh1234" });
    await settings.update({ proxyUrl: "http://127.0.0.1:8080" });
    // Omitted keys keep their stored value.
    expect(await settings.read()).toEqual({
      endpoint: "https://proxy.example/v1",
      proxyUrl: "http://127.0.0.1:8080",
      apiKey: "sk-abcdefgh1234",
    });
    // An explicit null clears only the named key.
    await settings.update({ apiKey: null });
    expect(await settings.read()).toEqual({
      endpoint: "https://proxy.example/v1",
      proxyUrl: "http://127.0.0.1:8080",
    });
    await settings.update({ proxyUrl: null });
    expect(await settings.read()).toEqual({ endpoint: "https://proxy.example/v1" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-http(s) URL or an empty key is rejected with a typed error", async () => {
  const { dir, store: settings } = store();
  try {
    await expect(settings.update({ endpoint: "ftp://example.com" })).rejects.toMatchObject({
      code: "jev_settings_invalid",
    });
    await expect(settings.update({ proxyUrl: "example.com:8080" })).rejects.toMatchObject({
      code: "jev_settings_invalid",
    });
    await expect(settings.update({ apiKey: "   " })).rejects.toMatchObject({
      code: "jev_settings_invalid",
    });
    // Nothing landed: the rejected patch left no file behind.
    expect(await settings.read()).toEqual({});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt secrets file fails closed instead of dropping the stored key", async () => {
  const { dir, store: settings, path } = store();
  try {
    writeFileSync(path, "{not json", "utf8");
    await expect(settings.read()).rejects.toMatchObject({ code: "jev_settings_unreadable" });
    await expect(settings.view()).rejects.toMatchObject({ code: "jev_settings_unreadable" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hand-written file keeps its stored values on the next patch", async () => {
  const { dir, store: settings, path } = store();
  try {
    writeFileSync(path, `${JSON.stringify({ apiKey: "sk-handwritten0001", model: "jev-future" }, null, 2)}\n`, "utf8");
    chmodSync(path, 0o600);
    const view = await settings.view();
    expect(view).toMatchObject({
      model: "jev-future",
      keyConfigured: true,
      keyMasked: "sk-…0001",
    });
    await settings.update({ endpoint: "https://api.typesafe.ai/v1/systemone" });
    expect(await settings.read()).toEqual({
      apiKey: "sk-handwritten0001",
      model: "jev-future",
      endpoint: "https://api.typesafe.ai/v1/systemone",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("echoing the masked key back on update keeps the stored key", async () => {
  const { dir, store: settings } = store();
  try {
    const first = await settings.update({ apiKey: "sk-1234567890abcd" });
    expect(first.keyMasked).toBe("sk-…abcd");
    // A client round-trips the whole view (endpoint + masked key) on save.
    const echoed = await settings.update({ endpoint: first.endpoint, apiKey: first.keyMasked! });
    expect(echoed).toMatchObject({ keyConfigured: true, keyMasked: "sk-…abcd" });
    expect((await settings.read()).apiKey).toBe("sk-1234567890abcd");
    // Surrounding whitespace on the echo is still the echo.
    await settings.update({ apiKey: `  ${first.keyMasked!}  ` });
    expect((await settings.read()).apiKey).toBe("sk-1234567890abcd");
    // A real new key still replaces it.
    await settings.update({ apiKey: "sk-new-key-99998888" });
    expect((await settings.read()).apiKey).toBe("sk-new-key-99998888");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a masked-looking key that is not the current preview is refused, not stored", async () => {
  const { dir, store: settings } = store();
  try {
    // No key yet: a pasted preview must not become the stored secret.
    await expect(settings.update({ apiKey: "sk-…abcd" })).rejects.toMatchObject({ code: "jev_settings_invalid" });
    expect(await settings.read()).toEqual({});
    await settings.update({ apiKey: "sk-1234567890abcd" });
    // A stale preview of some other key is refused and the stored key survives.
    await expect(settings.update({ apiKey: "sk-…zzzz" })).rejects.toMatchObject({ code: "jev_settings_invalid" });
    expect((await settings.read()).apiKey).toBe("sk-1234567890abcd");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("echoing the masked proxy URL back keeps the stored credentials", async () => {
  const { dir, store: settings } = store();
  try {
    const first = await settings.update({ proxyUrl: "http://user:s3cretpass@proxy.local:7890" });
    expect(first.proxyUrl).toBe("http://***@proxy.local:7890");
    expect(JSON.stringify(first)).not.toContain("s3cretpass");
    await settings.update({ proxyUrl: first.proxyUrl! });
    expect((await settings.read()).proxyUrl).toBe("http://user:s3cretpass@proxy.local:7890");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
