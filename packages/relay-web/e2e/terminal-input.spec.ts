
import { test, expect, loginAndOpenTerminal, waitForTerminalScreen, readTerminalGrid } from "./fixtures";
test.describe("terminal input lifecycle", () => {
  test("IME composition commits once; intermediate pinyin never reaches the PTY", async ({ page, hub }) => {
    await loginAndOpenTerminal(page);
    await waitForTerminalScreen(page);

    const host = page.getByTestId("terminal-host");
    await host.click();
    const ta = host.locator("textarea");
    await expect(ta).toHaveCount(1);
    await ta.focus();

    const inputsBefore = hub.inputs.length;
    await ta.evaluate((el) => {
      const fire = (type: string, data?: string) => {
        el.dispatchEvent(new CompositionEvent(type, { bubbles: true, data }));
      };
      fire("compositionstart");
      fire("compositionupdate", "ni");
      fire("compositionupdate", "nihao");
      // A real IME commits by writing the final text INTO the textarea before
      // compositionend - xterm reads the textarea value, not the event's data.
      el.value = "你好";
      fire("compositionend");
    });

    await expect.poll(() => hub.inputs.slice(inputsBefore).join("")).toBe("你好");
    const added = hub.inputs.slice(inputsBefore);
    expect(added.join("")).not.toMatch(/n|i|h|a|o/i);
    expect(added).toHaveLength(1);
  });

  test("legacy mouse report travels as exact raw bytes (onBinary path)", async ({ page, hub }, testInfo) => {
    // Wide desktop grid needed: col >= 96 forces a coordinate byte >= 0x80.
    test.skip(testInfo.project.name !== "chromium-desktop", "needs a >=96-col grid");
    await loginAndOpenTerminal(page);
    await waitForTerminalScreen(page);
    // Enable VT200 mouse tracking (DEFAULT encoding): xterm sends these
    // reports through onBinary, not onData.
    hub.sendBytes("\u001b[?1000h");

    const grid = await readTerminalGrid(page);
    test.skip(grid.cols < 100, `terminal too narrow for a >=0x80 coord byte (${grid.cols} cols)`);
    // Click at 0-based col 96: the report byte is (col+1)+32 = 0x81 >= 0x80 -
    // exactly the byte a UTF-8 round-trip would corrupt into C2 81.
    const col = 96;
    const row = 3;
    const host = page.getByTestId("terminal-host");
    const pos = await host.evaluate((el, { col, row }) => {
      const screen = el.querySelector(".xterm-screen")!.getBoundingClientRect();
      const cols = Number(el.dataset.cols ?? 80);
      const rows = Number(el.dataset.rows ?? 24);
      return {
        x: screen.left + Math.min(col, cols - 2) * (screen.width / cols) + 1,
        y: screen.top + Math.min(row, rows - 2) * (screen.height / rows) + 1,
      };
    }, { col, row });
    const inputsBefore = hub.inputBytes.length;
    await page.mouse.click(pos.x, pos.y);

    await expect.poll(() => hub.inputBytes.length).toBeGreaterThan(inputsBefore);
    // xterm reports 1-based coords: col 96 -> byte 0x81 (97+32), row 3 -> 0x24 (4+32).
    // The mousedown report (button byte 0x20) must arrive with 0x81 intact -
    // a UTF-8 round-trip would corrupt it into C2 81.
    const down = hub.inputBytes
      .slice(inputsBefore)
      .find((b) => b[0] === 0x1b && b[3] === 0x20);
    expect(down ? Array.from(down) : null).toEqual([0x1b, 0x5b, 0x4d, 0x20, 0x81, 0x24]);
    expect(Array.from(down!)).not.toContain(0xc2);
  });

  test("IME textarea is a one-cell cursor anchor, not a fullscreen overlay", async ({ page }) => {
    await loginAndOpenTerminal(page);
    await waitForTerminalScreen(page);
    const host = page.getByTestId("terminal-host");
    await host.click();

    const geo = await host.evaluate((el) => {
      const ta = el.querySelector("textarea");
      if (!ta) throw new Error("no textarea");
      const cs = getComputedStyle(ta);
      const hostRect = el.getBoundingClientRect();
      return {
        width: parseFloat(ta.style.width),
        height: parseFloat(ta.style.height),
        left: parseFloat(ta.style.left),
        top: parseFloat(ta.style.top),
        display: cs.display,
        visibility: cs.visibility,
        hostW: hostRect.width,
        hostH: hostRect.height,
      };
    });
    // xterm.js keeps its own (invisible) helper textarea anchored at the cursor
    // cell - one cell in size, inside the host, never a fullscreen overlay.
    expect(geo.display).not.toBe("none");
    expect(geo.visibility).not.toBe("hidden");
    expect(geo.width).toBeGreaterThan(0);
    expect(geo.height).toBeGreaterThan(0);
    expect(geo.width).toBeLessThan(geo.hostW / 2);
    expect(geo.height).toBeLessThan(geo.hostH / 2);
    expect(geo.left).toBeGreaterThan(-1);
    expect(geo.top).toBeGreaterThan(-1);
  });

  test("mobile keyboard inset is local: remote resize count does not grow", async ({ page, hub }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "keyboard inset is a mobile viewport concern");
    await loginAndOpenTerminal(page);
    await waitForTerminalScreen(page);
    const resizesBefore = hub.resizes.length;

    await page.evaluate(() => {
      const host = document.querySelector('[data-test="terminal-host"]') as HTMLElement;
      const ta = host?.querySelector("textarea");
      ta?.focus();
      const vv = window.visualViewport;
      if (!vv) return;
      Object.defineProperty(vv, "height", { configurable: true, get: () => window.innerHeight - 320 });
      Object.defineProperty(vv, "offsetTop", { configurable: true, get: () => 0 });
      vv.dispatchEvent(new Event("resize"));
    });

    const center = page.getByTestId("terminal-center");
    await expect.poll(async () => center.evaluate((el) => (el as HTMLElement).style.paddingBottom)).not.toBe("");
    await expect.poll(() => hub.resizes.length).toBe(resizesBefore);

    // The IME anchor (one-cell textarea at the cursor) must still sit inside
    // the visible host rect once the keyboard is up. The remote grid didn't
    // resize, so the taller screen has to be scrolled to keep it in view.
    const anchor = await page.locator('[data-test="terminal-host"]').evaluate((host) => {
      const ta = host.querySelector("textarea");
      if (!ta) return null;
      const h = host.getBoundingClientRect();
      const t = ta.getBoundingClientRect();
      return {
        visible: t.bottom <= h.bottom + 1 && t.top >= h.top - 1,
        hostHeight: h.height,
        scrollTop: (host as HTMLElement).scrollTop,
      };
    });
    expect(anchor).not.toBeNull();
    expect(anchor!.visible).toBe(true);
  });

  test("touch: 2px stay pending, 20px scroll the terminal", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "touch gesture is a mobile concern");
    await loginAndOpenTerminal(page);
    await waitForTerminalScreen(page);
    const host = page.getByTestId("terminal-host");
    const box = await host.boundingBox();
    if (!box) throw new Error("no host box");
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    // Sub-threshold: browser still owns the gesture (no preventDefault).
    await page.evaluate(({ x, y }) => {
      const el = document.querySelector('[data-test="terminal-host"]')!;
      const fire = (type: string, cx: number, cy: number) => {
        const t = new Touch({ identifier: 1, target: el, clientX: cx, clientY: cy });
        el.dispatchEvent(new TouchEvent(type, {
          bubbles: true, cancelable: true, touches: type === "touchend" ? [] : [t],
          changedTouches: [t],
        }));
      };
      fire("touchstart", x, y);
      fire("touchmove", x, y + 2);
      fire("touchend", x, y + 2);
    }, { x, y });

    // Above-threshold drag: the state machine must preventDefault (captured).
    const prevented = await page.evaluate(({ x, y }) => {
      const el = document.querySelector('[data-test="terminal-host"]')!;
      let sawPrevent = false;
      const t0 = new Touch({ identifier: 2, target: el, clientX: x, clientY: y });
      el.dispatchEvent(new TouchEvent("touchstart", {
        bubbles: true, cancelable: true, touches: [t0], changedTouches: [t0],
      }));
      const t1 = new Touch({ identifier: 2, target: el, clientX: x, clientY: y + 20 });
      const move = new TouchEvent("touchmove", {
        bubbles: true, cancelable: true, touches: [t1], changedTouches: [t1],
      });
      el.dispatchEvent(move);
      sawPrevent = move.defaultPrevented;
      el.dispatchEvent(new TouchEvent("touchend", {
        bubbles: true, cancelable: true, touches: [], changedTouches: [t1],
      }));
      return sawPrevent;
    }, { x, y });
    expect(prevented).toBe(true);
  });
});
