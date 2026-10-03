# Feishu Card-Action (Elicitation Form) Deployment Runbook

This is the deployment runbook milestone M5 asked for: how to get the Feishu
**card-callback** path working end to end, and what breaks capability when any
part of it is missing.

**Who this is for:** an operator deploying xacpx's Feishu channel in production.

**What this runbook does NOT claim:** no live round trip was performed while
writing it. See [Verification status](#verification-status).

---

## 1. Why `cardActions` is a separate channel

Feishu delivers interactive-card events (button clicks, form submits) as
**HTTP callbacks**. The WebSocket long connection the channel already uses cannot
carry them — it subscribes to events only. So the callback is a separate, opt-in
HTTP surface, configured per account under `cardActions`.

**Consequence for capability:** without `cardActions`, no answer can ever arrive.
The channel still starts its WebSocket, still receives messages, and still
participates in turns — but it **cannot deliver an elicitation form**. That is why
capability is gated on it (§5).

---

## 2. Configuration

```jsonc
{
  "type": "feishu",
  "textMessageFormat": "text",
  "accounts": {
    "primary": {
      "appId": "cli_xxxx",
      "appSecret": "sxxxx",
      "enabled": true,
      "configured": true,
      "domain": "feishu",
      // Opt-in. Omit it and this account cannot deliver a form.
      "cardActions": {
        "encryptKey": "<64-hex>",
        "verificationToken": "<token>",
        "host": "127.0.0.1",
        "port": 9877,
        "path": "/webhook/card"
      }
    }
  }
}
```

### Field notes

| Field | Required | Notes |
|---|---|---|
| `cardActions.encryptKey` | **yes** | New-protocol signing secret. See §4.2. |
| `cardActions.verificationToken` | **yes** | URL-verification credential. See §4.2. |
| `cardActions.host` | no | Defaults to `127.0.0.1`. See §6. |
| `cardActions.port` | **yes** | Each account owns its port; a shared port makes accounts fight over one socket. |
| `cardActions.path` | no, recommended | Route Feishu POSTs to, e.g. `/webhook/card`. |

`port` is per-account by nature — do not alias two accounts onto one port.

---

## 3. Sequence

```text
Feishu console
  → public HTTPS callback URL
  → cardActions.path
  → host / bind
  → port
  → verificationToken
  → encryptKey
  → URL verification
  → reverse proxy / TLS responsibility
  → process/network exposure model
  → card click smoke test
```

### 3.1 Get the values from the Feishu console

In your Feishu app's console:

1. Enable the **event subscription / callback** capability.
2. Set the **request URL** to `https://<your-host>/webhook/card`.
3. Copy the **Encrypt Key** and **Verification Token** the console shows.
4. Subscribe to the **card interaction** event (`card.action.trigger` and the URL
   verification challenge).

### 3.2 Configure the account

Add the values from §2. Use a real `port` per account. Keep `host` on loopback
until §6 is deliberately addressed.

### 3.3 Start the channel

On start, the account's listener binds `host:port` and serves `path`. Startup
failure is fatal for that account's listener — it does not fall back to a degraded
mode.

### 3.4 URL verification

The console immediately POSTs a `url_verification` challenge to your endpoint:

```json
{"type": "url_verification", "challenge": "..."}
```

The channel answers it with the echoed `challenge`. It is authenticated **solely
by constant-time comparison of the payload's `token` against
`cardActions.verificationToken`**, and it is recognized **before** the normal
signature check. See §4.3 for why that is safe.

The console then reports the endpoint as verified.

### 3.5 TLS / reverse proxy

If the channel binds loopback (the default), something must terminate TLS and
forward to it. Example with Caddy:

```text
feishu.example.com {
    reverse_proxy 127.0.0.1:9877
}
```

**The channel does not terminate TLS.** A reverse proxy, ALB, or Cloudflare
tunnel must do it, and must speak HTTPS to Feishu. Feishu requires a public HTTPS
URL; it rejects plain HTTP and self-signed certificates.

### 3.6 Card click smoke test

1. Start a Direct Bot conversation that triggers an elicitation (a form field, for
   example).
2. A card renders with buttons.
3. Click Submit.
4. Confirm the turn resumes with the answer.

If step 2 renders nothing, capability is likely the issue — see §5 and §7.

---

## 4. Authentication: two paths, two purposes

### 4.1 What each credential is for

| Credential | Verifies | Used by |
|---|---|---|
| `verificationToken` | that the caller is *the Feishu console you configured* | URL verification challenge |
| `encryptKey` | that the payload was signed by Feishu (new protocol) | real card actions |

### 4.2 Why both are required

They are not redundant.

`verifyCardRequest` picks the signing secret **by protocol**:

- A callback carrying `encrypt` or `schema` is **new protocol** → verified with
  **SHA-256 over the encrypt key**.
- A push with neither marker is **legacy** → verified with **SHA-1 over the
  verificationToken**.

Every button the renderer emits carries `schema: "2.0"`, so every real click is
new protocol. That is why `encryptKey` is mandatory: it is the trust anchor for
the path that actually carries answers.

`verificationToken` is separately required because the **URL-verification
challenge** arrives with **no signature headers at all** — neither new-protocol
nor legacy. The echoed token is that handshake's only credential. Without it the
channel starts, serves every click correctly, and still reports
"not configured" in the console forever.

### 4.3 Why the token-authenticated challenge is not a bypass

The challenge is recognized **before** `verifyCardRequest()` runs. That is
deliberate — it matches the official SDK's `autoChallenge`, which also runs before
`dispatcher.invoke()`. Recognizing an early handshake message does not weaken the
guard on anything that comes after it:

- unknown or missing `token` on the challenge → **401**
- a real card action still must pass the full signature check; the challenge path
  handles only `type: "url_verification"` and returns immediately after echoing

So the ordering is: handshake recognized early, real actions authenticated in
full. Not: handshake opens a hole.

---

## 5. Capability: when form support is declared

The channel declares `elicitationModes` **from config**, in the constructor.

### 5.1 The rule

```text
No account has cardActions      -> elicitationModes = []      (cannot deliver)
Any account lacks cardActions   -> elicitationModes = []      (mixed: cannot be described truthfully)
Every inbound account has it    -> elicitationModes = ["form"] (can deliver)
```

### 5.2 Why "mixed" declares nothing

`elicitationModes` is **channel-scoped** — one answer for the whole plugin.
`requestElicitation` is **account-scoped** — it resolves the account from the
`chatKey` and throws when that account has no listener.

So in a mixed setup, an account without `cardActions` still starts its WebSocket,
still receives messages, still receives human turns — and **cannot** deliver a
form. Declaring form for that channel would tell every agent "form works here",
then cancel **every** request routed to the listener-less account.

Declaring nothing is honest and still fully usable for messaging.

### 5.3 Listener failure must fail closed

If a listener fails to bind at startup, that account cannot deliver a form. The
deployment rule this implies: **do not keep advertising form with a broken
listener.** Removing `cardActions` from the config is the supported way to take a
form-incapable account out of the capability calculation.

### 5.4 URL mode is never declared

`ChannelElicitationMode` is `"form"` only. No channel implements URL mode: there
is no URL dispatch, no `elicitationId`, no `elicitation/complete`, and no
consent-before-navigation step. Declaring it would advertise a capability that
does not exist.

---

## 6. Network exposure model

### 6.1 Default loopback is the safe default

`cardActions.host` defaults to `127.0.0.1`.

A card-callback listener is an **unauthenticated endpoint as far as the network is
concerned**. The token and encrypt key authenticate the *payload*; nothing
authenticates the *caller*. Anyone who can reach the port can POST to it.

So: bind loopback, put TLS and access control in front, and treat moving to a
non-loopback bind as an **explicit operator decision** that must be paired with a
firewall rule, a reverse proxy with TLS, and ideally an allowlist of Feishu
egress IPs.

### 6.2 Exposure checklist

- [ ] `host` is `127.0.0.1` (or a private interface you have deliberately chosen)
- [ ] TLS is terminated in front of the listener, by something you control
- [ ] the public hostname is Feishu-only if possible; otherwise add an allowlist
- [ ] no other service shares the port
- [ ] `encryptKey` and `verificationToken` came from the console, not invented

---

## 7. Troubleshooting

| Symptom | Likely cause |
|---|---|
| No form ever appears, turn cancels with "no card-callback channel" | the account has no `cardActions`, or a mixed set is suppressing capability (§5.2) |
| Console says "verification failed" | `verificationToken` mismatch, or `path` does not match the console URL, or the proxy is not forwarding |
| Console says "verification failed" but the token is correct | TLS problem in front: plain HTTP, self-signed cert, or proxy returning a 301 |
| Clicking a button does nothing | `encryptKey` mismatch (new-protocol signature fails), or the console is on the legacy protocol without the token |
| Two accounts, one works, one does not | per-account `port` collision; give each its own |
| Form renders with a field greyed out and Submit disabled | multi-select is refused, not reshaped (§8) |

---

## 8. Known per-channel limitations

| Limitation | Behaviour |
|---|---|
| **multi-select fields** | Feishu cards have no multi-select component. A form containing one is **refused and cancelled**, never reshaped into single-select. Silently reshaping would send the agent an answer to a question it did not ask. |
| **URL mode** | Not supported and not declared. |
| **`--trust-proxy` style rate limiting** | The callback endpoint has no rate limiting of its own; put it in the proxy. |

---

## Verification status

Honest, per the M5 discipline:

| Layer | Status |
|---|---|
| Production code path exercised | partial — the channel is constructed with real config and its capability output asserted |
| Built artifact verified | **yes** — `tests/smoke/acp-elicitation-capability-artifact.test.ts` loads `packages/channel-feishu/dist/index.js` and pins all three capability cases plus the no-URL rule |
| Injected / loopback transport verified | yes — the card-listener unit suites bound real loopback ports and drove real signature checks |
| Real platform round trip | **not exercised** — no Feishu console credentials and no public HTTPS endpoint in the authoring environment |

**What to do before trusting this in production:** perform step 3.6 against your
own console. The runbook is complete enough to execute; it is not a substitute for
executing it.
