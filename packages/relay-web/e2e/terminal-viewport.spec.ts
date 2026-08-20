import { test, expect, loginAndOpenTerminal, waitForTerminalScreen, readTerminalGrid } from "./fixtures";

test.describe("terminal viewport", () => {
  test("initial open fills the host instead of staying at 80x24", async ({ page, hub }) => {
    await loginAndOpenTerminal(page);
    await waitForTerminalScreen(page);
    const grid = await readTerminalGrid(page);
    // Mobile viewports often fit fewer than 80 cols; the bug is staying at the
    // 80x24 bootstrap size, not "must be wider than 80".
    expect(grid.cols === 80 && grid.rows === 24).toBe(false);
    expect(grid.cols).toBeGreaterThan(20);
    expect(grid.rows).toBeGreaterThan(10);
    // The backend terminal-open must be born at the measured browser grid.
    // A later resize is no longer allowed to repair an 80x24 bootstrap PTY.
    expect(hub.lastOpen).not.toBeNull();
    expect(hub.lastOpen!.cols).toBe(grid.cols);
    expect(hub.lastOpen!.rows).toBe(grid.rows);
    expect(hub.lastOpen!.cols === 80 && hub.lastOpen!.rows === 24).toBe(false);
    // Sub-cell remainder is expected (items-center); never a whole unused cell.
    expect(grid.remainder).toBeLessThan(grid.screenWidth / grid.cols + 1);
    if (hub.resizes.length > 0) {
      const last = hub.resizes.at(-1)!;
      expect(last.cols).toBe(grid.cols);
      expect(last.rows).toBe(grid.rows);
    }
  });

  test("late rebase rebuilds at the keyframe size then re-fits the host", async ({ page, hub }) => {
    await loginAndOpenTerminal(page);
    await waitForTerminalScreen(page);
    const before = await readTerminalGrid(page);
    expect(before.cols === 80 && before.rows === 24).toBe(false);

    const resizesBefore = hub.resizes.length;
    hub.sendRebase(80, 24, "late");

    await expect.poll(async () => (await readTerminalGrid(page)).cols).toBe(before.cols);
    const after = await readTerminalGrid(page);
    expect(after.rows).toBe(before.rows);
    expect(after.cols === 80 && after.rows === 24).toBe(false);
    // Authoritative rebase (80x24) updates syncedResize belief, so the
    // subsequent forceSync sends a corrective resize back to host dimensions.
    expect(hub.resizes.length).toBeGreaterThan(resizesBefore);
    expect(last.cols).toBe(after.cols);
    expect(last.rows).toBe(after.rows);
  });

  test("spectator host resize never sends a backend resize", async ({ page, hub }) => {
    hub.setRole("spectator");
    await loginAndOpenTerminal(page);
    await waitForTerminalScreen(page);
    await expect(page.getByTestId("terminal-role")).toContainText(/spectator/i);
    expect(hub.resizes).toEqual([]);

    const before = await readTerminalGrid(page);
    await page.setViewportSize({ width: 700, height: 500 });
    await expect.poll(async () => {
      const next = await readTerminalGrid(page);
      return next.cols !== before.cols || next.rows !== before.rows;
    }).toBe(true);
    expect(hub.resizes).toEqual([]);
  });

  test("controller host resize pushes the final geometry", async ({ page, hub }) => {
    await loginAndOpenTerminal(page);
    await waitForTerminalScreen(page);
    const before = await readTerminalGrid(page);
    const countBefore = hub.resizes.length;

    await page.setViewportSize({ width: 1100, height: 720 });
    await expect.poll(async () => (await readTerminalGrid(page)).cols).not.toBe(before.cols);
    const after = await readTerminalGrid(page);
    const pushed = hub.resizes.slice(countBefore);
    expect(pushed.length).toBeGreaterThan(0);
    const last = pushed.at(-1)!;
    expect(last.cols).toBe(after.cols);
    expect(last.rows).toBe(after.rows);
  });

  test("take-control syncs the current browser geometry to the backend", async ({ page, hub }) => {
    hub.setRole("spectator");
    await loginAndOpenTerminal(page);
    await waitForTerminalScreen(page);
    expect(hub.resizes).toEqual([]);
    const grid = await readTerminalGrid(page);

    await page.getByTestId("terminal-take-control").click();
    await expect.poll(() => hub.lastTakeControl !== null).toBe(true);
    await expect.poll(() => hub.resizes.length).toBeGreaterThan(0);
    const last = hub.resizes.at(-1)!;
    expect(last.cols).toBe(grid.cols);
    expect(last.rows).toBe(grid.rows);
  });

  test("reconnect + rebase recovers a filled viewport", async ({ page, hub }) => {
    await loginAndOpenTerminal(page);
    await waitForTerminalScreen(page);
    const before = await readTerminalGrid(page);
    expect(before.cols === 80 && before.rows === 24).toBe(false);

    hub.closeSockets();
    await expect.poll(() => hub.sockets.length).toBeGreaterThan(0);
    // Reopen re-issues terminal-open; mock replies with 80x24 rebase then the
    // browser must re-fit just like the first open.
    await expect.poll(async () => {
      const grid = await readTerminalGrid(page);
      return !(grid.cols === 80 && grid.rows === 24) && grid.cols > 20;
    }).toBe(true);
    const after = await readTerminalGrid(page);
    expect(after.cols === 80 && after.rows === 24).toBe(false);
  });
});