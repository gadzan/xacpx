import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { useFue, resetFue } from "../lib/use-fue";
import { computeCalloutPlacement } from "../lib/fue-placement";
import FueCallout from "../components/FueCallout.vue";

describe("useFue state machine", () => {
  beforeEach(() => resetFue("feat-x"));

  it("starts unseen, engages, then acknowledges and persists", () => {
    const a = useFue("feat-x");
    expect(a.status.value).toBe("unseen");
    a.engage();
    expect(a.status.value).toBe("engaging");
    a.dismiss();
    expect(a.status.value).toBe("acknowledged");
    // A fresh instance reads the persisted acknowledgement.
    const b = useFue("feat-x");
    expect(b.status.value).toBe("acknowledged");
  });

  it("engage is a no-op once acknowledged", () => {
    const a = useFue("feat-x");
    a.dismiss();
    a.engage();
    expect(a.status.value).toBe("acknowledged");
  });

  it("resetFue clears the acknowledgement", () => {
    useFue("feat-x").dismiss();
    resetFue("feat-x");
    expect(useFue("feat-x").status.value).toBe("unseen");
  });
});

describe("computeCalloutPlacement", () => {
  const vp = { width: 1000, height: 800 };
  const callout = { width: 256, height: 100 };

  it("places below the anchor by default", () => {
    const p = computeCalloutPlacement({ top: 100, left: 400, width: 40, height: 20 }, callout, vp);
    expect(p.placement).toBe("below");
    expect(p.top).toBe(100 + 20 + 8);
  });

  it("flips above when below overflows and above has more room", () => {
    const p = computeCalloutPlacement({ top: 760, left: 400, width: 40, height: 20 }, callout, vp);
    expect(p.placement).toBe("above");
    expect(p.top).toBe(760 - 100 - 8);
  });

  it("clamps the horizontal position into the viewport", () => {
    const nearRight = computeCalloutPlacement({ top: 100, left: 980, width: 40, height: 20 }, callout, vp);
    expect(nearRight.left).toBe(vp.width - callout.width - 8); // 736
    const nearLeft = computeCalloutPlacement({ top: 100, left: 0, width: 10, height: 20 }, callout, vp);
    expect(nearLeft.left).toBe(8);
  });
});

describe("FueCallout component", () => {
  it("renders title/body and emits dismiss on Got it", async () => {
    const w = mount(FueCallout, { props: { title: "Hi", body: "There", anchor: null } });
    // Teleported to body — query the document, not the wrapper subtree.
    const el = document.querySelector('[data-test="fue-callout"]');
    expect(el?.textContent).toContain("Hi");
    expect(el?.textContent).toContain("There");
    const btn = document.querySelector('[data-test="fue-dismiss"]') as HTMLButtonElement;
    btn.click();
    await w.vm.$nextTick();
    expect(w.emitted("dismiss")).toBeTruthy();
    w.unmount();
  });
});
