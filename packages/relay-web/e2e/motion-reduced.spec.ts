import { test, expect, loginAndShowInstances } from "./fixtures";

/**
 * Motion is one vocabulary outside the composer, and every transform
 * transition on a non-composer control stops under `prefers-reduced-motion`.
 * The unit test guards the source text; this one reads the computed style of
 * the real app, so a utility that Tailwind never emits (a typo, a class the
 * content scan dropped) still fails here.
 */
test("reduced motion cancels non-composer transitions", async ({ page }) => {
  await loginAndShowInstances(page);

  const probe = () => page.evaluate(() => {
    const read = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const style = getComputedStyle(el);
      return { property: style.transitionProperty, duration: style.transitionDuration };
    };
    return {
      chevron: read('[data-test="instance-header-toggle"] svg'),
      swipeTrack: read('[data-test="swipe-track"]'),
      sidebar: read('[data-drawer="left"]'),
    };
  });

  const normal = await probe();
  expect(normal.chevron?.property).toBe("transform");
  expect(normal.chevron?.duration).toBe("0.15s");
  expect(normal.sidebar?.property).toBe("width");

  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await probe();

  // `transition-none` leaves the duration in place; what cancels the motion is
  // the empty transition-property list.
  for (const [name, value] of Object.entries(reduced)) {
    expect(value, name).not.toBeNull();
    expect(value!.property, name).toBe("none");
  }
});
