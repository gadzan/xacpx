export default {
  // The codemod fixtures intentionally keep pre-migration tokens as literals;
  // scanning them would emit dead CSS for rounded-md, text-[10px], and friends.
  content: ["./index.html", "./src/**/*.{vue,ts}", "!./src/__tests__/codemod-radius.test.ts", "!./src/__tests__/codemod-type.test.ts"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: "rgb(var(--c-bg) / <alpha-value>)",
        surface: "rgb(var(--c-surface) / <alpha-value>)",
        "surface-2": "rgb(var(--c-surface-2) / <alpha-value>)",
        raised: "rgb(var(--c-raised) / <alpha-value>)",
        // The hairline edge. --c-border is a neutral grey, so it is only ever
        // used with an alpha; the hairline tokens below are the pre-composed
        // values for the common cases.
        border: "rgb(var(--c-border) / <alpha-value>)",
        fg: "rgb(var(--c-fg) / <alpha-value>)",
        "fg-muted": "rgb(var(--c-fg-muted) / <alpha-value>)",
        accent: "rgb(var(--c-accent) / <alpha-value>)",
        "accent-hover": "rgb(var(--c-accent-hover) / <alpha-value>)",
        // Blue TEXT and icons. One step deeper than `accent`, so it stays
        // legible on a pale accent tint.
        "accent-text": "rgb(var(--c-accent-text) / <alpha-value>)",
        "on-accent": "rgb(var(--c-on-accent) / <alpha-value>)",
        run: "rgb(var(--c-run) / <alpha-value>)",
        "run-bright": "rgb(var(--c-run-bright) / <alpha-value>)",
        warn: "rgb(var(--c-warn) / <alpha-value>)",
        danger: "rgb(var(--c-danger) / <alpha-value>)",
        // An rgba token, not an RGB triple: it composites over whatever sits
        // under it. It therefore takes no `/50` opacity modifier.
        "accent-soft": "var(--accent-soft)",
        "on-warn": "rgb(var(--c-on-warn) / <alpha-value>)",
        info: "rgb(var(--c-info) / <alpha-value>)",
        // Overlay-scrim variants. A scrim dims the surface under a dialog or
        // a menu, so text there needs one step more contrast than the same
        // text on the bare canvas. These are the measured values.
        "danger-overlay": "rgb(var(--c-danger-overlay) / <alpha-value>)",
        "warn-overlay": "rgb(var(--c-warn-overlay) / <alpha-value>)",
        "run-overlay": "rgb(var(--c-run-overlay) / <alpha-value>)",
        "fg-muted-overlay": "rgb(var(--c-fg-muted-overlay) / <alpha-value>)",
        "accent-text-overlay": "rgb(var(--c-accent-text-overlay) / <alpha-value>)",
        // Translucent greys. These are rgba, not an RGB triple, so they do NOT
        // accept a `/50` opacity modifier — change the token instead.
        hairline: "var(--hairline)",
        "hairline-strong": "var(--hairline-strong)",
        "fill-hover": "var(--fill-hover)",
        "fill-strong": "var(--fill-strong)",
        "fill-track": "var(--fill-track)",
        // Glass surfaces. Same caveat as the fill tokens above.
        glass: "var(--glass-bg)",
        "glass-strong": "var(--glass-bg-strong)",
        scrim: "var(--scrim)",
      },
      borderRadius: {
        sm: "6px",
        lg: "10px",
        "2xl": "16px",
        btn: "8px",
        input: "7px",
        card: "12px",
        dialog: "16px",
        item: "5px",
      },
      fontSize: {
        xs: ["12px", "18px"],
        ui: ["13px", "20px"],
        sm: ["14px", "22px"],
        base: ["16px", "24px"],
        xl: ["20px", "28px"],
      },
      fontFamily: {
        // System font stack: SF on macOS/iOS, Segoe UI on Windows, Inter as the
        // web fallback.
        sans: ['-apple-system', 'BlinkMacSystemFont', '"SF Pro Text"', '"Segoe UI"', 'Inter', '"PingFang SC"', '"Noto Sans SC"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      transitionTimingFunction: {
        // Non-composer controls only. The composer keeps its own 200ms ease-out.
        ui: "cubic-bezier(.23,1,.32,1)",
      },
      backdropBlur: {
        glass: "var(--glass-blur)",
      },
      backdropSaturate: {
        glass: "var(--glass-saturate)",
      },
      boxShadow: {
        float: "var(--shadow-float)",
        card: "var(--shadow-card)",
        select: "var(--shadow-select)",
        press: "var(--shadow-press)",
        pop: "var(--shadow-pop)",
        dialog: "var(--shadow-dialog)",
        glass: "inset 0 1px 0 var(--glass-highlight), inset 0 0 0 1px var(--glass-border)",
        "glass-float": "inset 0 1px 0 var(--glass-highlight), inset 0 0 0 1px var(--glass-border), var(--glass-shadow)",
      },
    },
  },
  plugins: [],
};
