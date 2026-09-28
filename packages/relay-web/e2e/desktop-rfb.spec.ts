// Relay Web instance desktop over RFB: browser-level E2E.
//
// Drives the assembled path a real user takes — click the instance Desktop
// entry, VNC password prompt, connect — with REAL noVNC (lazy-loaded chunk)
// in a REAL Chromium, talking RFB to a mock server through the mock hub's
// binary /desktop/observe pipe.
//
// Why this exists at all: unit tests prove the client's noVNC contract
// (credentials OBJECT, scaleViewport property, the _isSupportedSecurityType /
// _negotiateAuthentication / _fail hooks it patches), and the hub's broker.
// Neither proves the two halves actually meet: that the frame reaches noVNC
// as an RFB banner, that VncAuth negotiates, and that a rejected password
// surfaces as an auth failure rather than a timeout.
//
// Scope (the plan's Task 10): full VNC handshake through connect, framebuffer
// visibility on the rendered canvas, pointer/keyboard input reaching the RFB
// server as client messages, close + reopen with a fresh hub stream, and the
// fit/fullscreen toggles. Plus the rejected-password path: noVNC emits
// securityfailure for a rejected password and then disconnect, so a harness
// that only half-provisions the mock server produces a "timeout" that looks
// exactly like a production bug.
//
// Desktop project only: the Desktop entry lives in the instance header, which
// the mobile layout collapses behind the sidebar, so the flow this asserts is
// not reachable on a phone-sized viewport (by design, not by defect).
import { expect, test as desktopTest, loginAndShowInstances } from "./fixtures";
import type { Page } from "@playwright/test";
import { createServer, type Server } from "node:net";

const RFB_BANNER = Buffer.from("RFB 003.008\n", "ascii");
/** One security type: VncAuth (2). */
const SECURITY_LIST = Buffer.from([1, 2]);
/** Fixed challenge so the run is deterministic (noVNC does the DES work). */
const CHALLENGE = Buffer.alloc(16, 0x5a);

interface MockRfb {
  port: number;
  /** Bytes the browser sent after auth completed (pointer / key frames). */
  clientTraffic: Buffer[];
  /** Set once SecurityResult(OK) was sent. */
  authenticated: boolean;
  /** True once the DES response was actually received from the browser. */
  sawDesResponse: boolean;
  /** Every FramebufferUpdate actually sent, so the browser's canvas proves out. */
  updates: Array<{ rects: number; bytes: number }>;
  /**
   * Client message TYPES decoded from the live RFB stream, in arrival order.
   * A growing byte total can be produced by a FramebufferUpdateRequest alone,
   * so input assertions read these instead: 4 = KeyEvent, 5 = PointerEvent.
   */
  clientMessageTypes: Array<{ type: number; expectedBytes: number }>;
  /** True once a KeyEvent (type 4) has been decoded. */
  sawKeyEvent: boolean;
  /** True once a PointerEvent (type 5) has been decoded. */
  sawPointerEvent: boolean;
  close(): Promise<void>;
}

/**
 * One FramebufferUpdate (message 0) covering a single 8x8 Raw rectangle.
 * Raw encoding is the one every client must support, so no capability
 * negotiation is needed; padding to 32-bit boundaries is required by RFB.
 */
function sendFramebufferUpdate(socket: net.Socket): number {
  const header = Buffer.alloc(4);
  header.writeUInt8(0, 0); // message type: FramebufferUpdate
  header.writeUInt8(0, 1); // padding
  header.writeUInt16BE(1, 2); // number of rectangles
  const rect = Buffer.alloc(12);
  rect.writeUInt16BE(0, 0); // x
  rect.writeUInt16BE(0, 2); // y
  rect.writeUInt16BE(8, 4); // width
  rect.writeUInt16BE(8, 6); // height
  rect.writeInt32BE(0, 8); // encoding: Raw
  const pixels = Buffer.alloc(8 * 8 * 4, 0x22);
  socket.write(Buffer.concat([header, rect, pixels]));
  return pixels.byteLength;
}

/**
 * Client message type -> total message length, per RFB §7.5.
 *
 * Input messages have fixed sizes (KeyEvent 8, PointerEvent 6), but so does the
 * FramebufferUpdateRequest (10) that a connected client sends unprompted. A
 * byte total therefore cannot attribute growth to input; decoding the type
 * bits is what makes an input assertion meaningful.
 */
const CLIENT_MESSAGE_LENGTHS: Record<number, number> = {
  0: 20, // SetPixelFormat: type + 3 pad + pixel format
  2: 4,  // SetEncodings header (type + pad + u16 count), string below
  3: 10, // FramebufferUpdateRequest: type + pad + x + y + w + h
  4: 8,  // KeyEvent: type + pad + u32 key
  5: 6,  // PointerEvent: type + pad + u16 x + u16 y
  6: 8,  // ClientCutText: type + 3 pad + u32 length (string follows)
};

/** RFB message-type numbers the tests assert on. */
const RFB_KEY_EVENT = 4;
const RFB_POINTER_EVENT = 5;

/**
 * Walk one client buffer and report the message types it starts with. Partial
 * messages (a body that continues in a later TCP segment) are skipped: the
 * next segment re-walks from there, and the tests only need the type bit.
 */
function decodeClientMessageTypes(buf: Buffer): Array<{ type: number; expectedBytes: number }> {
  const out: Array<{ type: number; expectedBytes: number }> = [];
  let offset = 0;
  while (offset < buf.byteLength) {
    const type = buf[offset];
    if (type === undefined) break;
    const expected = CLIENT_MESSAGE_LENGTHS[type] ?? 0;
    if (expected === 0) break; // unknown message: stop rather than desync
    out.push({ type, expectedBytes: expected });
    if (type === 2) {
      // SetEncodings is variable length: header + 4 bytes per encoding id.
      const count = buf.readUInt16BE(offset + 2);
      offset += 4 + count * 4;
    } else {
      offset += expected;
    }
  }
  return out;
}

/**
 * RFB 003.008 server with VncAuth. The handshake is phase-per-frame rather
 * than "wait for 17 bytes": noVNC sends its 16-byte DES response as soon as
 * the password is submitted and then WAITS for SecurityResult before it sends
 * the ClientInit byte, so batching both deadlocks the exchange. A rejected
 * password additionally needs the RFB 3.8 failure-reason string, because
 * noVNC routes a failed result to SecurityReason and parses it before
 * dispatching `securityfailure`.
 */
function startMockRfb(opts: { rejectPassword?: boolean } = {}): Promise<MockRfb> {
  const clientTraffic: Buffer[] = [];
  const updates: Array<{ rects: number; bytes: number }> = [];
  const clientMessageTypes: Array<{ type: number; expectedBytes: number }> = [];
  const state = { authenticated: false, sawDesResponse: false, sawKeyEvent: false, sawPointerEvent: false };
  const sockets: net.Socket[] = [];
  return new Promise((resolve) => {
    let server: Server;
    server = createServer((socket) => {
      sockets.push(socket);
      socket.on("close", () => {
        const i = sockets.indexOf(socket);
        if (i >= 0) sockets.splice(i, 1);
      });
      socket.on("error", () => {});
      socket.write(RFB_BANNER);
      let phase: "version" | "choice" | "auth" | "init" | "live" = "version";
      let buffered = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (phase === "live") {
          if (buffered.length > 0) {
            clientTraffic.push(Buffer.from(buffered));
            // Decode the message types now, while the segment boundary is
            // still visible: a client message that straddles two segments is
            // reported when its body completes.
            for (const msg of decodeClientMessageTypes(buffered)) {
              clientMessageTypes.push(msg);
              if (msg.type === RFB_KEY_EVENT) state.sawKeyEvent = true;
              if (msg.type === RFB_POINTER_EVENT) state.sawPointerEvent = true;
            }
            buffered = Buffer.alloc(0);
          }
          return;
        }
        if (phase === "version") {
          if (buffered.length < 12) return;
          buffered = buffered.subarray(12);
          phase = "choice";
          socket.write(SECURITY_LIST);
          return;
        }
        if (phase === "choice") {
          if (buffered.length < 1) return;
          buffered = buffered.subarray(1);
          phase = "auth";
          socket.write(CHALLENGE);
          return;
        }
        if (phase === "auth") {
          if (buffered.length < 16) return;
          buffered = buffered.subarray(16);
          state.sawDesResponse = true;
          if (opts.rejectPassword) {
            // SecurityResult(failed) + the RFB 3.8 failure-reason string:
            // (u32 length, ASCII text). noVNC routes a 3.8 failure to
            // SecurityReason and reads this before it dispatches
            // `securityfailure`, so omitting it leaves the client stalled in
            // "connecting" — the misleading symptom the app takes care to
            // surface properly.
            socket.write(Buffer.from(new Uint32Array([1]).buffer)); // SecurityResult: failed
            const reason = Buffer.from("authentication failure", "ascii");
            const len = Buffer.alloc(4);
            len.writeUInt32BE(reason.byteLength, 0);
            socket.write(Buffer.concat([len, reason]));
            socket.end();
            return;
          }
          socket.write(Buffer.from(new Uint32Array([0]).buffer)); // SecurityResult: OK
          phase = "init";
          state.authenticated = true;
        }
        // ClientInit (1 byte shared flag) -> ServerInit (24-byte PIXEL_FORMAT +
        // width/height + name). noVNC may already have sent it in this segment.
        if (phase === "init") {
          if (buffered.length < 1) return;
          buffered = buffered.subarray(1);
          phase = "live";
          const name = Buffer.from("xacpx-e2e", "ascii");
          const si = Buffer.alloc(24);
          si.writeUInt16BE(1024, 0); // width
          si.writeUInt16BE(768, 2); // height
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
          if (buffered.length > 0) {
            clientTraffic.push(Buffer.from(buffered));
            buffered = Buffer.alloc(0);
          }
          // A trivial framebuffer update so the client has live data to map.
          // Without one the desktop renders a blank canvas, and pointer input
          // on a zero-sized framebuffer is meaningless to assert on.
          const sentBytes = sendFramebufferUpdate(socket);
          updates.push({ rects: 1, bytes: sentBytes });
          return;
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("mock RFB failed to bind");
      resolve({
        port: addr.port,
        clientTraffic,
        updates,
        clientMessageTypes,
        get authenticated() { return state.authenticated; },
        get sawDesResponse() { return state.sawDesResponse; },
        get sawKeyEvent() { return state.sawKeyEvent; },
        get sawPointerEvent() { return state.sawPointerEvent; },
        close: () =>
          new Promise((r) => {
            // server.close() waits for every live connection: the browser holds
            // one for the whole desktop session, so without an explicit peer
            // teardown this hangs until the test times out. Tracked sockets are
            // the browser-side RFB connections; destroy them, then close.
            for (const sock of sockets.splice(0)) sock.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

async function openDesktop(page: Page): Promise<void> {
  await loginAndShowInstances(page);
  const entry = page.getByTestId("instance-desktop");
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await entry.click();
  await expect(page.getByTestId("desktop-center")).toBeVisible();
}

/** Drive the VncAuth prompt to the connected state. */
async function connectDesktop(page: Page): Promise<void> {
  await expect(page.getByTestId("desktop-status")).toContainText(/password/i, { timeout: 30_000 });
  await expect(page.getByTestId("desktop-password")).toBeVisible();
  await page.getByTestId("desktop-password").fill("s3cret");
  await page.getByTestId("desktop-password-submit").click();
  await expect(page.getByTestId("desktop-status")).toContainText(/connected/i, { timeout: 30_000 });
  await expect(page.getByTestId("desktop-password")).toBeHidden();
}

desktopTest.describe("Relay Web instance desktop over RFB", () => {
  // Mobile project: the Desktop entry lives in the instance header, which the
  // mobile layout collapses behind the sidebar. The flow is not reachable on a
  // phone-sized viewport by design.
  desktopTest.skip(({ isMobile }) => isMobile === true, "instance desktop needs the desktop layout");
  desktopTest("vnc-auth password connects desktop to the RFB server", async ({ page, hub }) => {
    const rfb = await startMockRfb();
    hub.setDesktopRfb(rfb.port);
    await openDesktop(page);
    await connectDesktop(page);

    // noVNC's post-connect setup (SetPixelFormat, SetEncodings,
    // FramebufferUpdateRequest) is the real proof that both halves of the
    // desktop plane actually meet: the server answered ServerInit and the
    // client spoke RFB back. A harness that stubbed noVNC, or forwarded the
    // wrong bytes, could not get here.
    await expect
      .poll(() => rfb.clientTraffic.reduce((sum, b) => sum + b.byteLength, 0), { timeout: 15_000 })
      .toBeGreaterThan(0);
    expect(rfb.authenticated).toBe(true);
    await rfb.close();
  });

  desktopTest("framebuffer updates reach the browser and render on the canvas", async ({ page, hub }) => {
    // A visible framebuffer is the point of the feature. Assert on the mock's
    // server-side send AND the browser's rendered canvas, so a server that
    // never speaks framebuffer cannot satisfy this by accident.
    const rfb = await startMockRfb();
    hub.setDesktopRfb(rfb.port);
    await openDesktop(page);
    await connectDesktop(page);

    expect(rfb.updates.length).toBeGreaterThan(0);
    expect(rfb.updates[0]).toEqual({ rects: 1, bytes: 8 * 8 * 4 });

    // noVNC creates a canvas inside our host and sizes it to the framebuffer.
    // The desktop tab's own fit toggle keeps the label in the first fit state,
    // so the canvas element itself must exist and be sized.
    const canvas = page.locator('[data-test="desktop-host"] canvas').first();
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);

    await rfb.close();
  });

  desktopTest("pointer and keyboard input become RFB client messages", async ({ page, hub }) => {
    // The interactive half of "watch AND control". noVNC 1.7.0 connected with
    // viewOnly=false grabs the keyboard and registers mousedown/mousemove/
    // mouseup on its canvas, so a real click / keypress on the canvas must
    // produce PointerEvent + KeyEvent messages upstream.
    const rfb = await startMockRfb();
    hub.setDesktopRfb(rfb.port);
    await openDesktop(page);
    await connectDesktop(page);

    // A connected client already emits setup traffic (SetPixelFormat,
    // SetEncodings, FramebufferUpdateRequest), so the baseline is the decoded
    // message count BEFORE the input actions.
    const baselineMessages = rfb.clientMessageTypes.length;
    const canvas = page.locator('[data-test="desktop-host"] canvas').first();
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    if (!box) throw new Error("desktop canvas has no box");
    // Click the canvas CENTRE via the real mouse: noVNC listens for mousedown
    // on the canvas element, so the event must land on it, not on an overlay.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await page.keyboard.press("KeyX");

    // noVNC dispatches PointerEvents in coalescing batches, so poll for the
    // decoded count to settle rather than expecting one message per event.
    await expect.poll(() => rfb.clientMessageTypes.length, { timeout: 15_000 })
      .toBeGreaterThan(baselineMessages);
    expect(rfb.sawPointerEvent).toBe(true);
    expect(rfb.sawKeyEvent).toBe(true);

    await rfb.close();
  });

  desktopTest("closing the desktop closes the stream and the entry stays usable", async ({ page, hub }) => {
    const rfb = await startMockRfb();
    hub.setDesktopRfb(rfb.port);
    await openDesktop(page);
    await connectDesktop(page);

    // Close from the panel's own Disconnect button.
    await page.getByTestId("desktop-close").click();
    await expect(page.getByTestId("desktop-center")).toBeHidden();

    // The hub was told to close the stream it minted.
    expect(hub.desktopCloseRequests.length).toBeGreaterThan(0);
    expect(hub.desktopCloseRequests[0]).toBe(hub.desktopStreamIds[0]);
    // The instance entry survives: closing is a normal user action, and the
    // capability must not have been dropped by it, so reopen is possible.
    await expect(page.getByTestId("instance-desktop")).toBeVisible();

    await rfb.close();
  });

  desktopTest("reopen after close establishes a second independent stream", async ({ page, hub }) => {
    // v1 is single-stream per instance, so a reopen must go through the whole
    // hub handshake again (a fresh streamId + a fresh ticket) rather than
    // reusing or resurrecting the closed one.
    const rfb = await startMockRfb();
    hub.setDesktopRfb(rfb.port);
    await openDesktop(page);
    await connectDesktop(page);

    await page.getByTestId("desktop-close").click();
    await expect(page.getByTestId("desktop-center")).toBeHidden();
    const firstStreamId = hub.desktopStreamIds[0];
    expect(hub.desktopCloseRequests[0]).toBe(firstStreamId);

    await page.getByTestId("instance-desktop").click();
    await expect(page.getByTestId("desktop-center")).toBeVisible();
    await connectDesktop(page);

    expect(hub.desktopStreamIds.length).toBe(2);
    expect(hub.desktopStreamIds[1]).not.toBe(firstStreamId);
    await expect(page.getByTestId("desktop-status")).toContainText(/connected/i);

    await rfb.close();
  });

  desktopTest("fit and fullscreen toggles reach the noVNC client", async ({ page, hub }) => {
    const rfb = await startMockRfb();
    hub.setDesktopRfb(rfb.port);
    await openDesktop(page);
    await connectDesktop(page);

    const fit = page.getByTestId("desktop-fit-toggle");
    const fullscreen = page.getByTestId("desktop-fullscreen-toggle");
    await expect(fit).toBeVisible();
    await expect(fullscreen).toBeVisible();

    // fit starts ON (the store seeds fit:true and the wrapper applies it to
    // `scaleViewport` once noVNC resolves).
    await expect(fit).toHaveAttribute("aria-label", /fit/i);
    await fit.click();
    await expect(fit).toHaveAttribute("aria-label", /actual/i);
    await fit.click();
    await expect(fit).toHaveAttribute("aria-label", /fit/i);

    await fullscreen.click();
    await expect(fullscreen).toHaveAttribute("aria-label", /exit/i);
    await fullscreen.click();
    await expect(fullscreen).toHaveAttribute("aria-label", /^fullscreen$/i);

    await rfb.close();
  });

  desktopTest("a rejected vnc password reports an auth failure, not a timeout", async ({ page, hub }) => {
    // The regression: noVNC emits securityfailure for a REJECTED password and
    // then (because _fail() marks the connection unclean) disconnect. Mapping
    // the disconnect instead overwrites "your password is wrong" with a
    // generic stream timeout, which reads to the user as "server broken".
    const rfb = await startMockRfb({ rejectPassword: true });
    hub.setDesktopRfb(rfb.port);
    await openDesktop(page);

    await expect(page.getByTestId("desktop-password")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("desktop-password").fill("definitely-wrong");
    await page.getByTestId("desktop-password-submit").click();

    const banner = page.getByTestId("desktop-error");
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText(/password/i);
    await expect(banner).not.toContainText(/not supported/i);
    await expect(banner).not.toContainText(/timed out/i);
    // The failure came from the RFB server, so the mock saw the DES response.
    expect(rfb.sawDesResponse).toBe(true);

    await rfb.close();
  });
});
