import { expect, test } from "bun:test";

import { CommandTimeoutError } from "../../../src/transport/command-timeouts";
import {
  CAPABILITY_PROBE_SESSION_NAME,
  executeCapabilityProbe,
  type ProbeCommandResult,
} from "../../../src/agents/capability-probe";

function result(code: number, stdout: string, stderr = ""): ProbeCommandResult {
  return { code, stdout, stderr };
}

test("the probe creates no user prompt and closes the reserved session", async () => {
  const tails: string[][] = [];
  const deleted: string[] = [];
  const outcome = await executeCapabilityProbe({
    run: async (_stage, tail) => {
      tails.push(tail);
      if (tail[0] === "sessions" && tail[1] === "new") return result(0, "{\"action\":\"session_ensured\"}");
      if (tail[0] === "status") {
        return result(0, JSON.stringify({ model: "gpt-real", availableModels: ["gpt-real", "gpt-other"] }));
      }
      if (tail[1] === "show") {
        return result(0, JSON.stringify({
          acpxRecordId: "probe1234",
          acpx: {
            available_model_names: { "gpt-real": "GPT Real" },
            config_options: [{
              id: "reasoning_effort",
              category: "thought_level",
              currentValue: "high",
              options: [{ value: "low" }, { value: "high" }],
            }],
          },
        }));
      }
      return result(0, "");
    },
    deleteRecord: async (id) => { deleted.push(id); },
  }, 5_000, () => 0);
  expect(tails.some((tail) => tail.includes("prompt"))).toBe(false);
  expect(tails[0]).toEqual(["sessions", "new", "--name", CAPABILITY_PROBE_SESSION_NAME]);
  expect(tails.at(-1)).toEqual(["sessions", "close", CAPABILITY_PROBE_SESSION_NAME]);
  expect(deleted).toEqual(["probe1234"]);
  expect(outcome).toEqual({
    ok: true,
    models: [
      { modelId: "gpt-real", name: "GPT Real" },
      { modelId: "gpt-other", name: "gpt-other" },
    ],
    currentModelId: "gpt-real",
    efforts: ["low", "high"],
    currentEffort: "high",
  });
});

test("authentication failure is needs-setup material and does not look like an empty catalog", async () => {
  const outcome = await executeCapabilityProbe({
    run: async () => result(1, "", "Error: authentication required"),
    deleteRecord: async () => {},
  }, 5_000, () => 0);
  expect(outcome).toEqual({
    ok: false,
    failure: "unauthenticated",
    message: "the adapter requires authentication before it can list models",
  });
});

test("a started adapter with no models is unsupported", async () => {
  const outcome = await executeCapabilityProbe({
    run: async (_stage, tail) => {
      if (tail[0] === "status") return result(0, JSON.stringify({ model: null, availableModels: [] }));
      if (tail[1] === "show") return result(0, JSON.stringify({ acpxRecordId: "probe1234", acpx: {} }));
      return result(0, "");
    },
    deleteRecord: async () => {},
  }, 5_000, () => 0);
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.failure).toBe("unsupported");
});

test("a timeout after the session exists is reported and the reserved session is still closed", async () => {
  const tails: string[][] = [];
  const outcome = await executeCapabilityProbe({
    run: async (_stage, tail) => {
      tails.push(tail);
      if (tail[1] === "new") return result(0, "");
      if (tail[0] === "status") throw new CommandTimeoutError(1000, "acpx status", { stage: "capability-probe-status" });
      return result(0, "");
    },
    deleteRecord: async () => {},
  }, 5_000, () => 0);
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.failure).toBe("timeout");
  expect(tails.at(-1)).toEqual(["sessions", "close", CAPABILITY_PROBE_SESSION_NAME]);
});

test("models are discarded when the probe session cannot be cleaned up", async () => {
  const outcome = await executeCapabilityProbe({
    run: async (_stage, tail) => {
      if (tail[0] === "status") return result(0, JSON.stringify({ availableModels: ["gpt-real"] }));
      if (tail[1] === "show") return result(0, JSON.stringify({ acpxRecordId: "probe1234" }));
      if (tail[1] === "close") return result(1, "", "still running");
      return result(0, "");
    },
    deleteRecord: async () => { throw new Error("disk busy"); },
  }, 5_000, () => 0);
  expect(outcome).toEqual({
    ok: false,
    failure: "cleanup",
    message: "the capability probe created a session it could not close",
  });
});
