import { expect, test } from "bun:test";

import { isModelNotAdvertisedError } from "../../../src/transport/model-not-advertised";

test("matches acpx 'did not advertise that model' rejection", () => {
  const msg =
    'Cannot apply --model "gpt-5.5/high": the ACP agent did not advertise that model. ' +
    "Available models: gpt-5.5[low], gpt-5.5[medium], gpt-5.5[high].";
  expect(isModelNotAdvertisedError(msg)).toBe(true);
});

test("matches acpx 'did not advertise model support' rejection", () => {
  const msg =
    'Cannot apply --model "gpt-5.5/high": the ACP agent did not advertise model support ' +
    "through a session config option or legacy models metadata, and the adapter does not " +
    "support a startup model flag.";
  expect(isModelNotAdvertisedError(msg)).toBe(true);
});

test("matches the replay-saved-model variant", () => {
  const msg = 'Cannot replay saved model "gpt-5.5/high": the ACP agent did not advertise that model.';
  expect(isModelNotAdvertisedError(msg)).toBe(true);
});

test("matches even when interleaved with [acpx] log lines", () => {
  const msg = [
    "[acpx] spawning built-in agent @agentclientprotocol/codex-acp@^0.0.44",
    "[acpx] initialized protocol version 1",
    'Cannot apply --model "gpt-5.5/high": the ACP agent did not advertise that model. Available models: gpt-5.5[high].',
  ].join("\n");
  expect(isModelNotAdvertisedError(msg)).toBe(true);
});

test("does not match unrelated session-creation failures", () => {
  expect(isModelNotAdvertisedError("session initialization timed out after 120s")).toBe(false);
  expect(isModelNotAdvertisedError("EPERM: rename index.json.tmp failed")).toBe(false);
  expect(isModelNotAdvertisedError("failed to create session")).toBe(false);
});

test("is null/undefined safe", () => {
  expect(isModelNotAdvertisedError(undefined)).toBe(false);
  expect(isModelNotAdvertisedError(null)).toBe(false);
  expect(isModelNotAdvertisedError("")).toBe(false);
});
