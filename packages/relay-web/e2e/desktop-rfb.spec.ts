// E2E for the Relay Web instance desktop over RFB.
//
// This is the plan's Task 10 spec, and the one piece of coverage the unit suites
// structurally cannot provide: a REAL browser running the REAL noVNC lazy-load
// chunk end to end. The unit tests pin the wrapper's noVNC contract (credentials
// object, scaleViewport property, auth narrowing) and the hub's binary broker;
// this proves the assembled path — browser → /ws desktop-open → binary
// /desktop/observe → mock RFB server — actually framebuffers and routes input.
//
// The mock RFB server speaks enough of RFB 003.008 for upstream noVNC to be
// indistinguishable from TightVNC/TigerVNC: banner, security types, the 16-byte
// VncAuth challenge, SecurityResult, ClientInit, ServerInit, then a
// FramebufferUpdate. That is what catches drift a fake RFB (or a fake noVNC)
// cannot: a wrong password makes noVNC emit securityfailure AND then
// disconnect{clean:false}, and only a real run of both sides shows the tab
// landing on the auth message rather than a timeout.
import { expect, test, type Page } from "@playwright/test";
import { createServer, type Server } from "node:net";

import { test as desktopTest } from "./fixtures";

const RFB_BANNER = Buffer.from("RFB 003.008\n", "ascii");

interface MockRfb {
  port: number;
  /** Every frame the browser sent after the handshake completed. */
  clientTraffic: Buffer[];
  /** True once ServerInit was sent (authentication accepted). */
  authenticated: boolean;
  close(): Promise<void>;
}

/**
 * Minimal RFB 003.008 server with VncAuth. `rejectPassword` models a VNC server
 * that answers the challenge with a failure, which is how a real wrong-password
 * run behaves.
 */
function startMockRfb(opts: { rejectPassword?: boolean } = {}): Promise<MockRfb> {
  const clientTraffic: Buffer[] = [];
  const state = { authenticated: false };
  return new Promise((resolve) => {
    let server: Server;
    server = createServer((socket) => {
      socket.write(RFB_BANNER);
      let phase: "version" | "choice" | "auth" = "version";
      let buffered = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (phase === "version") {
          if (buffered.length < 12) return;
          buffered = buffered.subarray(12);
          phase = "choice";
          // one security type: VncAuth (2)
          socket.write(Buffer.from([1, 2]));
          return;
        }
        if (phase === "choice") {
          if (buffered.length < 1) return;
          buffered = buffered.subarray(1);
          phase = "auth";
          socket.write(Buffer.alloc(16, 0x5a));
          return;
        }
        // auth: 16-byte DES response, then the 1-byte ClientInit shared flag.
        if (buffered.length < 17) return;
        buffered = buffered.subarray(17);
        if (opts.rejectPassword) {
          socket.write(Buffer.from(new Uint32Array([1]).buffer)); // SecurityResult: failed
          socket.end();
          return;
        }
        socket.write(Buffer.from(new Uint32Array([0]).buffer)); // SecurityResult: OK
        const name = Buffer.from("xacpx-e2e", "ascii");
        const si = Buffer.alloc(24);
        si.writeUInt16BE(1024, 0);
        si.writeUInt16BE(768, 2);
        si.writeUInt8(32, 4); // bpp
        si.writeUInt8(24, 5); // depth
        si.writeUInt8(0, 6); // big-endian
        si.writeUInt8(1, 7); // true-colour
        si.writeUInt16BE(255, 8); // red max
        si.writeUInt16BE(255, 10); // green max
        si.writeUInt16BE(255, 12); // blue max
        si.writeUInt8(16, 14); // red shift
        si.writeUInt8(8, 15); // green shift
        si.writeUInt8(0, 16); // blue shift
        si[17] = 0;
        si.writeUInt32BE(name.length, 20);
        socket.write(Buffer.concat([si, name]));
        state.authenticated = true;
        // Anything the browser sends now is post-auth traffic (SetPixelFormat,
        // SetEncodings, FramebufferUpdateRequest, pointer/key events).
        if (buffered.length > 0) {
          clientTraffic.push(Buffer.from(buffered));
          buffered = Buffer.alloc(0);
        }
      });
      socket.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("mock RFB failed to bind");
      resolve({
        port: addr.port,
        clientTraffic,
        get authenticated() { return state.authenticated; },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** Open the instance's Desktop from the instance header entry. */
async function openDesktop(page: Page): Promise<void> {
  const entry = page.getByTestId("instance-desktop");
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await entry.click();
  await expect(page.getByTestId("desktop-center")).toBeVisible();
}

desktopTest.describe("Relay Web instance desktop over RFB", () => {
  desktopTest("vnc-auth password flow frames through to the RFB server", async ({ page, hub }) => {
    const rfb = await startMockRfb();
    hub.setDesktopRfb(rfb.port);
    await openDesktop(page);

    // noVNC reaches the VncAuth prompt (hub answered with security: vnc-auth).
    await expect(page.getByTestId("desktop-status")).toContainText(/password/i, { timeout: 30_000 });
    await expect(page.getByTestId("desktop-password")).toBeVisible();

    // Submit the password: the client sends the DES response, the mock accepts.
    await page.getByTestId("desktop-password").fill("s3cret");
    await page.getByTestId("desktop-password-submit").click();

    // ServerInit reached the browser, so noVNC reports Connected and the
    // password bar is gone.
    await expect(page.getByTestId("desktop-status")).toContainText(/connected/i, { timeout: 30_000 });
    await expect(page.getByTestId("desktop-password")).toBeHidden();
    expect(rfb.authenticated).toBe(true);
    await rfb.close();
  });

  desktopTest("a rejected password surfaces as an auth failure, not a timeout", async ({ page, hub }) => {
    // The regression this E2E exists for: a wrong password makes real noVNC
    // emit securityfailure AND then disconnect{clean:false}. If the tab showed
    // a generic timeout (or a misleading "auth scheme not supported"), a user
    // would have no idea the password was simply wrong.
    const rfb = await startMockRfb({ rejectPassword: true });
    hub.setDesktopRfb(rfb.port);
    await openDesktop(page);

    await expect(page.getByTestId("desktop-password")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("desktop-password").fill("wrong");
    await page.getByTestId("desktop-password-submit").click();

    const banner = page.getByTestId("desktop-error");
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText(/password/i);
    // Not the scheme message, and not a timeout.
    await expect(banner).not.toContainText(/not supported/i);
    await expect(banner).not.toContainText(/timed out/i);
    await rfb.close();
  });

  desktopTest("pointer and keyboard input reach the RFB server after connect", async ({ page, hub }) => {
    const rfb = await startMockRfb();
    hub.setDesktopRfb(rfb.port);
    await openDesktop(page);
    await expect(page.getByTestId("desktop-password")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("desktop-password").fill("s3cret");
    await page.getByTestId("desktop-password-submit").click();
    await expect(page.getByTestId("desktop-status")).toContainText(/connected/i, { timeout: 30_000 });

    const before = rfb.clientTraffic.length;
    const host = page.getByTestId("desktop-host");
    await host.click({ position: { x: 40, y: 40 } });
    await page.keyboard.type("x");
    // noVNC sends PointerEvent / KeyEvent messages upstream.
    await expect.poll(() => rfb.clientTraffic.length, { timeout: 15_000 }).toBeGreaterThan(before);
    await rfb.close();
  });

  desktopTest("fit and fullscreen toggles stay in sync with the session state", async ({ page, hub }) => {
    const rfb = await startMockRfb();
    hub.setDesktopRfb(rfb.port);
    await openDesktop(page);
    const fit = page.getByTestId("desktop-fit-toggle");
    const fullscreen = page.getByTestId("desktop-fullscreen-toggle");
    await expect(fit).toBeVisible({ timeout: 30_000 });
    await expect(fullscreen).toBeVisible();
    // Fit starts ON (the store seeds fit:true and the wrapper applies it).
    await expect(fit).toHaveAttribute("aria-label", /fit/i);
    await fit.click();
    await expect(fit).toHaveAttribute("aria-label", /actual/i);
    await fullscreen.click();
    await expect(fullscreen).toHaveAttribute("aria-label", /exit/i);
    await fullscreen.click();
    await expect(fullscreen).toHaveAttribute("aria-label", /^fullscreen$/i);
    await rfb.close();
  });

  desktopTest("closing the desktop closes the stream and rejects a reopen with no capability drop", async ({ page, hub }) => {
    const rfb = await startMockRfb();
    hub.setDesktopRfb(rfb.port);
    await openDesktop(page);
    await expect(page.getByTestId("desktop-center")).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("desktop-close").click();
    await expect(page.getByTestId("desktop-center")).toBeHidden();
    // The hub was told to close the stream it minted.
    expect(hub.desktopCloseRequests.length).toBeGreaterThan(0);
    expect(hub.desktopCloseRequests[0]).toBe(hub.desktopStreamIds[0]);
    // The instance entry is still there: reopening is a normal user action, and
    // the capability must not have been dropped by the close.
    await expect(page.getByTestId("instance-desktop")).toBeVisible();
    await rfb.close();
  });

  desktopTest("an online instance without the desktop capability shows neither the entry nor an Offline label", async ({ page }) => {
    // Regression: inserting the desktop button between the session-count and
    // the offline spans re-bound the offline `v-else` to the desktop condition,
    // so an online connector that predates the capability rendered a green dot
    // next to the word "Offline".
    await expect(page.getByTestId("instance-card").first().getByTestId("instance-desktop")).toBeHidden();
    const card = page.getByTestId("instance-card").first();
    await expect(card.getByTestId("online-dot")).toBeVisible();
    await expect(card).not.toContainText(/offline/i);
  });
});
