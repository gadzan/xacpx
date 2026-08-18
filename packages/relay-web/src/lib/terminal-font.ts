// Lazily injects the JetBrainsMono Nerd Font Mono webfont (via cdn.jsdmirror.com, a
// China-reachable mirror of jsDelivr) and waits for it to load. Called before the xterm.js
// terminal is constructed so its first char-size measure uses the real font. Idempotent;
// failures (blocked/offline/timeout) resolve silently - the terminal falls back to monospace.

const BASE = "https://cdn.jsdmirror.com/gh/mshaugh/nerdfont-webfonts@v3.3.0/build/fonts";
export const TERMINAL_FONT_FAMILY = "JetBrainsMono NFM";

let injected = false;
let loaded: Promise<void> | undefined;

export function ensureTerminalFont(): Promise<void> {
  if (loaded) return loaded;
  loaded = (async () => {
    try {
      if (typeof document === "undefined") return;
      if (!injected) {
        injected = true;
        const style = document.createElement("style");
        style.dataset.terminalFont = "1";
        style.textContent = `
@font-face{font-family:"${TERMINAL_FONT_FAMILY}";font-weight:400;font-style:normal;font-display:swap;
  src:url("${BASE}/JetBrainsMonoNerdFontMono-Regular.woff2") format("woff2");}
@font-face{font-family:"${TERMINAL_FONT_FAMILY}";font-weight:700;font-style:normal;font-display:swap;
  src:url("${BASE}/JetBrainsMonoNerdFontMono-Bold.woff2") format("woff2");}`;
        document.head.appendChild(style);
      }
      const fonts = (document as unknown as { fonts?: { load?: (f: string) => Promise<unknown> } }).fonts;
      if (fonts?.load) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((r) => { timer = setTimeout(r, 4000); });
        await Promise.race([
          Promise.resolve(fonts.load(`13px "${TERMINAL_FONT_FAMILY}"`)).then(() => {}, () => {}),
          timeout,
        ]);
        if (timer) clearTimeout(timer);
      }
    } catch {
      // silent fallback — font load failure or injection error, terminal uses monospace
    }
  })();
  return loaded;
}
