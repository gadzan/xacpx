import { describe, expect, it } from "vitest";
import { spaceNameForCjk } from "../lib/cjk-name-spacing";

describe("spaceNameForCjk", () => {
  it("spaces a Latin or digit name against the Chinese text before it", () => {
    expect(`派发给${spaceNameForCjk("Tester", "zh-CN", "before")}`).toBe("派发给 Tester");
    expect(`停止${spaceNameForCjk("Reviewer", "zh-CN", "before")}`).toBe("停止 Reviewer");
    expect(`停止${spaceNameForCjk("4o-bot", "zh-CN", "before")}`).toBe("停止 4o-bot");
  });

  it("keeps a Chinese name flush", () => {
    expect(`停止${spaceNameForCjk("项管", "zh-CN", "before")}`).toBe("停止项管");
    expect(`派发给${spaceNameForCjk("项管", "zh-CN", "before")}`).toBe("派发给项管");
    expect(`${spaceNameForCjk("项管", "zh-CN", "after")}和已派发的`).toBe("项管和已派发的");
  });

  it("spaces a Latin name against the Chinese text after it", () => {
    expect(`${spaceNameForCjk("Lead", "zh-CN", "after")}和已派发的`).toBe("Lead 和已派发的");
  });

  it("leaves other locales unchanged", () => {
    expect(spaceNameForCjk("Tester", "en", "before")).toBe("Tester");
  });
});
