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
} as const;
