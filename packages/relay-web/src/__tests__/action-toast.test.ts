import { describe, it, expect, vi } from "vitest";
import { showActionToast, useActionToastState, runToastAction, dismissToast } from "../lib/use-action-toast";

describe("action toast", () => {
  it("exposes the message + action and runs the action once", () => {
    const action = vi.fn();
    showActionToast({ message: 'Slept "x"', actionLabel: "Undo", action });
    expect(useActionToastState().value?.message).toContain("Slept");
    runToastAction();
    expect(action).toHaveBeenCalledTimes(1);
    expect(useActionToastState().value).toBeNull();
  });
  it("dismiss clears without running the action", () => {
    const action = vi.fn();
    showActionToast({ message: "m", actionLabel: "Undo", action });
    dismissToast();
    expect(action).not.toHaveBeenCalled();
    expect(useActionToastState().value).toBeNull();
  });
});
