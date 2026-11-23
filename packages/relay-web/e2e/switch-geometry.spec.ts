import { expect, test, loginAndShowInstances } from "./fixtures";

// The manage dialog and the settings page each hand-rolled a switch, and the
// dialog copy drifted: its knob sat 4px from the "on" edge and 2px from the
// "off" edge. One component now draws both; this measures the boxes, so
// re-splitting the geometry fails here.

/** The manage dialog hides a switch until its capability read lands, and the
 *  shared mock hub answers no settings RPC. Answer the three reads here; every
 *  other RPC falls back to the fixture's hub route. */
async function stubSettingsReads(page: import("@playwright/test").Page): Promise<void> {
  const READY = { status: "ready", configPath: "conversations.router" };
  const answers: Record<string, unknown> = {
    // The dialog's read of the router section is a `.update` with no patch: a
    // successful answer is what makes the switch editable.
    "control.conversations.router.update": { availability: READY, config: { enabled: true } },
    "control.conversations.router.get": READY,
    "control.terminal.settings.get": { enabled: false, restartRequired: true },
    "control.files.settings.get": { enabled: false, restartRequired: false },
  };
  await page.route("**/api/instances/*/rpc", async (route) => {
    let type = "";
    try {
      type = (JSON.parse(route.request().postData() ?? "{}") as { type?: string }).type ?? "";
    } catch { /* not JSON: let the hub answer */ }
    if (!(type in answers)) return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: answers[type] }) });
  });
}

test("switches keep the knob inset identical on both edges", async ({ page }) => {
  await loginAndShowInstances(page);
  await stubSettingsReads(page);
  await page.getByTestId("instance-nav-bots").first().click();
  await page.getByTestId("manage-instance-from-bots").first().click();
  await expect(page.getByTestId("router-toggle")).toBeVisible();

  const switches = await page.evaluate(() =>
    ["router-toggle", "terminal-settings-toggle", "files-settings-toggle"].map((id) => {
      const el = document.querySelector(`[data-test="${id}"]`)!;
      const track = el.getBoundingClientRect();
      const knob = el.querySelectorAll("span")[1].getBoundingClientRect();
      return {
        id,
        checked: el.getAttribute("aria-checked"),
        hit: [el.getBoundingClientRect().width, el.getBoundingClientRect().height],
        knob: knob.width,
        insets: {
          left: knob.left - track.left,
          right: track.right - knob.right,
          top: knob.top - track.top,
          bottom: track.bottom - knob.bottom,
        },
      };
    }),
  );

  expect(switches.map((s) => s.checked)).toContain("true");
  expect(switches.map((s) => s.checked)).toContain("false");
  for (const s of switches) {
    const { left, right, top, bottom } = s.insets;
    expect(s.hit, s.id).toEqual([44, 44]);
    expect(s.knob, s.id).toBe(20);
    // 3px from the edge the knob travels to, and the same 3px from the edge it
    // leaves — the drift bug measured 4 on one side and 2 on the other.
    expect(Math.min(left, right), s.id).toBeCloseTo(3, 1);
    expect(left + right, s.id).toBeCloseTo(44 - 20, 1);
    expect(top, s.id).toBeCloseTo(12, 1);
    expect(bottom, s.id).toBeCloseTo(12, 1);
  }
});
