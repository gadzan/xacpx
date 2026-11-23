import { test, expect, loginAndOpenTerminal, waitForTerminalScreen } from "./fixtures";

test.describe("terminal dialect contract", () => {
  test("xterm title metadata stays non-visual while command output renders", async ({ page, hub }) => {
    await loginAndOpenTerminal(page);
    await waitForTerminalScreen(page);

    // XACPX POSIX work panes advertise TERM=xterm-256color. Shell integrations
    // therefore use xterm-family OSC title controls instead of screen/tmux's
    // ESC k ... ST rename string. The browser renderer must consume the title
    // metadata without painting its payload into the terminal grid.
    const titleProbe = "__XACPX_XTERM_TITLE_PROBE__";
    const outputProbe = "__XACPX_XTERM_OUTPUT_PROBE__";
    hub.sendBytes(`\u001b]2;${titleProbe}\u0007${outputProbe}\r\n`);

    const rows = page.locator('[data-test="terminal-host"] .xterm-rows');
    await expect.poll(async () => rows.innerText()).toContain(outputProbe);

    const rendered = await rows.innerText();
    expect(rendered).not.toContain(titleProbe);
  });
});
