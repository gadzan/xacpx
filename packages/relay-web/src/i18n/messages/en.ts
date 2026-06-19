// English catalog. Each migration task appends its own namespace below.
// Values here MUST match the original hardcoded English exactly so existing
// test assertions on visible text keep passing.
export default {
  common: {
    cancel: "Cancel",
    confirm: "Confirm",
    ok: "OK",
    back: "← Back",
    delete: "Delete",
    dismiss: "dismiss",
  },
  connection: {
    online: "Connected",
    reconnecting: "Reconnecting…",
  },
  nav: {
    toLight: "Switch to light",
    toDark: "Switch to dark",
  },
  settings: {
    title: "Settings",
    appearance: "Appearance",
    theme: "Theme",
    dark: "Dark",
    light: "Light",
    language: "Language",
    addInstance: "Add an instance",
    instanceNamePlaceholder: "instance name (optional)",
    generateToken: "Generate token",
    runOnHost: "Run on the xacpx host:",
    retentionTitle: "History retention",
    retentionBody: "Keeps the newest {max} messages per session, for up to {days} days. Configured server-side.",
    account: "Account",
    signOut: "Sign out",
    signOutTitle: "Sign out?",
    signOutBody: "You'll need to sign in again to access the dashboard.",
  },
} as const;
