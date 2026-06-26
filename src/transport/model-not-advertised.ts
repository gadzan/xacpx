// Different agent adapters advertise model ids in different formats — e.g. the two codex
// adapters disagree on reasoning-effort suffixes (`gpt-5.5[high]` vs `gpt-5.5/high`). A model
// id that is valid under one adapter is therefore rejected by another, and acpx hard-fails
// session creation when a `--model` (or a replayed saved model) is not advertised.
//
// Transports use this to recognize that specific failure and retry session creation WITHOUT
// the model — falling back to the agent adapter's default — so a stale / cross-adapter /
// mistyped model override can never make a session uncreatable.
//
// Matched acpx messages (see ../../acpx/src/acp/model-support.ts):
//   Cannot apply --model "<id>": the ACP agent did not advertise that model. Available models: …
//   Cannot apply --model "<id>": the ACP agent did not advertise model support through …
//   Cannot replay saved model "<id>": the ACP agent did not advertise that model. …
export function isModelNotAdvertisedError(text: string | undefined | null): boolean {
  if (!text) return false;
  return (
    /Cannot (?:apply --model|replay saved model)\b/i.test(text) ||
    /did not advertise (?:that model|model support)/i.test(text)
  );
}
