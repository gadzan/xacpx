export default {
  content: ["./index.html", "./src/**/*.{vue,ts}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: "rgb(var(--c-bg) / <alpha-value>)",
        surface: "rgb(var(--c-surface) / <alpha-value>)",
        "surface-2": "rgb(var(--c-surface-2) / <alpha-value>)",
        raised: "rgb(var(--c-raised) / <alpha-value>)",
        border: "rgb(var(--c-border) / <alpha-value>)",
        fg: "rgb(var(--c-fg) / <alpha-value>)",
        "fg-muted": "rgb(var(--c-fg-muted) / <alpha-value>)",
        accent: "rgb(var(--c-accent) / <alpha-value>)",
        "accent-hover": "rgb(var(--c-accent-hover) / <alpha-value>)",
        "accent-soft": "rgb(var(--c-accent-soft) / <alpha-value>)",
        "on-accent": "rgb(var(--c-on-accent) / <alpha-value>)",
        run: "rgb(var(--c-run) / <alpha-value>)",
        "run-bright": "rgb(var(--c-run-bright) / <alpha-value>)",
        warn: "rgb(var(--c-warn) / <alpha-value>)",
        danger: "rgb(var(--c-danger) / <alpha-value>)",
        "on-danger": "rgb(var(--c-on-danger) / <alpha-value>)",
        "on-warn": "rgb(var(--c-on-warn) / <alpha-value>)",
        info: "rgb(var(--c-info) / <alpha-value>)",
      },
      borderRadius: {
        sm: "6px",
        lg: "10px",
        "2xl": "16px",
      },
      fontSize: {
        xs: ["12px", "18px"],
        ui: ["13px", "20px"],
        sm: ["14px", "22px"],
        base: ["16px", "24px"],
        xl: ["20px", "28px"],
      },
      fontFamily: {
        sans: ['Inter', '"PingFang SC"', '"Noto Sans SC"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        float: "var(--shadow-float)",
      },
    },
  },
  plugins: [],
};
