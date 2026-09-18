import { computed, onScopeDispose, ref, watch, type ComputedRef } from "vue";
import { useI18n } from "vue-i18n";
import { parseQuips, pickQuip } from "./working-quips";

/**
 * Playful rotating status line + a 1 Hz elapsed clock for an in-progress agent turn.
 * Lifted out of ChatPane's old turn-HUD so the same copy can ride the sticky
 * agent-icon as a speech bubble. `turnKey` identifies the current turn (re-picks the
 * quip and restarts the 20 s cadence when it changes; clears when null); `startedAt`
 * is the turn's epoch-ms origin for the elapsed readout.
 */
export function useWorkingQuip(
  turnKey: () => string | null,
  startedAt: () => number | null,
): { status: ComputedRef<string>; elapsed: ComputedRef<string> } {
  const { t } = useI18n();
  const quip = ref("");
  const nowMs = ref(Date.now());
  const clock = setInterval(() => { nowMs.value = Date.now(); }, 1000);

  let rotateTimer: ReturnType<typeof setInterval> | null = null;
  const ROTATE_MS = 20000;
  function rotate(): void {
    const quips = parseQuips(t("chat.workingQuips"));
    if (quips.length > 0) quip.value = pickQuip(quips, quip.value || undefined);
  }

  watch(
    turnKey,
    (key) => {
      if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
      if (key) {
        rotate();
        rotateTimer = setInterval(rotate, ROTATE_MS);
      } else {
        quip.value = "";
      }
    },
    { immediate: true },
  );
  // Re-pick on a mid-turn locale switch so the bubble doesn't stick in the old language.
  watch(() => t("chat.workingQuips"), () => { if (turnKey()) rotate(); });

  onScopeDispose(() => {
    clearInterval(clock);
    if (rotateTimer) clearInterval(rotateTimer);
  });

  // Quips are complete sentences (some already end in "…" / "."), so render verbatim;
  // only the short localized fallback gets a trailing ellipsis.
  const status = computed(() => quip.value || `${t("chat.mentionActivity.working")}…`);
  const elapsed = computed(() => {
    const st = startedAt();
    if (st === null) return "";
    const s = Math.max(0, Math.floor((nowMs.value - st) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  });

  return { status, elapsed };
}
