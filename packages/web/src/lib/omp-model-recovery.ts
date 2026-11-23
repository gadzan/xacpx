 const RESTORE_PHRASE = /\bCould not restore model\s+([^\s"'`]+)/gi;
 const MODEL_ID_TRAILING_PUNCTUATION = /[.,;:!?]+$/;
 const RESTORE_MODEL_USING_NOTICE = /\bUsing\b/i;
 
 export interface OmpRestoreFailure {
   driver: string | undefined;
   message: string;
   modelId: string;
 }
 
 /** Extract the restored model id from an OMP restore failure message, mirroring
  *  the backend matcher. Source excerpts can embed `${...}` template placeholders;
  *  those are skipped. OMP's non-fatal fallback notice (`Could not restore
  *  model X. Using Y`) means the switch SUCCEEDED with a substitute model, so
  *  a candidate whose own line continues with "Using …" never triggers the
  *  recovery banner. Otherwise the LAST valid id in the message wins. */
 export function ompRestoreFailure(driver: string | undefined, message: string): OmpRestoreFailure | null {
   if (driver !== "omp" || !message) return null;
   const matches = [...message.matchAll(RESTORE_PHRASE)];
   for (let index = matches.length - 1; index >= 0; index -= 1) {
     const match = matches[index]!;
     const candidate = match[1]?.replace(MODEL_ID_TRAILING_PUNCTUATION, "") ?? "";
     if (!candidate || candidate.includes("${")) continue;
     // Same-line fallback check, mirroring the backend: only "Using …"
     // following THIS match on its own line suppresses it.
     const lineEnd = message.indexOf("\n", match.index ?? 0);
     const line = message.slice(match.index ?? 0, lineEnd === -1 ? undefined : lineEnd);
     if (RESTORE_MODEL_USING_NOTICE.test(line.slice(match[0].length))) continue;
     return { driver, message, modelId: candidate };
   }
   return null;
 }

export function isOmpModelRestoreFailure(driver: string | undefined, message: string): boolean {
  return ompRestoreFailure(driver, message) !== null;
}
