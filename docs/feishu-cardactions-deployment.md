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
      "domain": "feishu",
      // Opt-in. Omit it and this account cannot deliver a form.
      "cardActions": {
        "encryptKey": "<encrypt-key-from-feishu-console>",
        "verificationToken": "<token-from-feishu-console>",
        "host": "127.0.0.1",
        "port": 9877,
        "path": "/webhook/card"
      }
    }
  }
}
```

`configured` is deliberately absent from the sample: it is not part of the
operator contract. It is derived as `Boolean(appId && appSecret)`
(`packages/channel-feishu/src/config.ts:190`) on the resolved
`FeishuResolvedAccountConfig`. Setting it by hand has no effect.

### Field notes

| Field | Required | Notes |
|---|---|---|
| `cardActions.encryptKey` | **yes** | New-protocol signing secret + decryption key. Any non-empty string; the repo does not impose a hex/length format. See §4.2. |
| `cardActions.verificationToken` | **yes** | Legacy signing secret, challenge credential, and the second check on new-protocol actions. See §4.1. |
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

## 4. Authentication: four branches

### 4.1 What each credential does

Neither credential has a single "one path each" job. They overlap by design, and
the table below lists every production branch — signature *and* whether a token
comparison happens after it — exactly as `verifyCardRequest()` implements them:

| Path | Signature / decrypt | `verificationToken` payload equality |
|---|---|---|
| **URL-verification challenge** (accepted before `verifyCardRequest`) | none — it carries no signature headers | **yes, and it is the only credential** |
| **real action, legacy** (no `encrypt`, no `schema`) | `sha1(timestamp + nonce + verificationToken + JSON.stringify(body))` | **yes, an explicit `record.token` comparison.** Required, not optional: an unconfigured token is itself a rejection on this branch |
| **real action, new protocol, unencrypted** | `sha256(... + encryptKey + ...)` | **yes, an explicit `record.token` comparison**, but only when a token is configured — an empty one skips the check rather than failing |
| **real action, new protocol, encrypted** | `sha256(... + encryptKey + ...)` over the envelope, then AES decrypt with `encryptKey` | **no.** This branch returns immediately after a successful decrypt and never reads the token |

So `verificationToken` is **not** only the challenge credential. It is the legacy
signing secret, an **explicit** legacy token check, and the second layer on
**unencrypted** new-protocol actions. `encryptKey` is the new-protocol signing
secret and the decryption key. Both are required, and dropping either leaves a
branch unverifiable.

The encrypted branch is the one that must be stated carefully, because two
claims that sound equivalent are not:

- **What it is authenticated by:** the encrypt-key signature **plus** successful
  decryption. There is no second token comparison.
- **What the freshness window does:** it *bounds the age* of a replayable
  request. It does **not** make a request single-use.

`verifyCardRequest()` checks that the signed timestamp is within 1800s
(`REQUEST_MAX_AGE_MS`), then decrypts. There is **no nonce cache and no
used-signature cache**, so an otherwise valid captured callback — timestamp,
nonce, signature, and encrypted body — passes host verification again for as long
as its timestamp stays fresh. This is proven behaviour, not a theoretical
concern: replaying one captured signed encrypted request three times yields
`200` each time and reaches the handler three times.

What keeps a duplicate from becoming a second answer is downstream, in the
interaction state machine: the generation fence, the claimed-generation gate, and
the first-terminal-decision-wins rule. Those limit duplicate **effects**; they do
not make the callback single-use at the authentication layer. If single-use
transport replay protection is wanted, that is a production design decision
(transport-level nonce cache) plus a regression test — not something the current
verification layer provides.

### 4.2 Why both are required

They are not redundant.

`verifyCardRequest` picks the signing secret **by protocol**
(`card-action-host.ts:334-336`):

- A callback carrying `encrypt` or `schema` is **new protocol** → verified with
  **SHA-256 over the encrypt key**.
- A push with neither marker is **legacy** → verified with **SHA-1 over the
  verificationToken**.

Every button the renderer emits carries `schema: "2.0"`, so every real click is
new protocol. That is why `encryptKey` is mandatory: it is the trust anchor for
the path that actually carries answers.

`verificationToken` is required for three separate reasons — the challenge (no
signature at all), the legacy signing secret with its explicit token check, and
the second-layer check on **unencrypted** new-protocol actions — so removing it
breaks all three.

### 4.3 Why the token-authenticated challenge is not a bypass

The challenge is recognized **before** `verifyCardRequest()` runs. That is
deliberate — it matches the official SDK's `autoChallenge`, which also runs before
`dispatcher.invoke()`. Recognizing an early handshake message does not weaken the
guard on anything that comes after it.

Stated precisely, the gate is **two conditions, not three**
(`extractUrlVerificationChallenge`, `card-action-host.ts:259-273`):

```text
a non-empty string `challenge`
  AND
token === verificationToken   (constant-time)
```

There is **no `type === "url_verification"` check.** The gate does not need one:
it only ever echoes the challenge back and returns, so a body that happens to
carry a matching token and a `challenge` field produces an echo and nothing else.
It cannot reach the renderer, cannot mutate state, and cannot settle an
interaction. What keeps it safe is what it *does* (nothing), not a discriminator
it never reads.

The guard on everything after it is unchanged. A real card action must pass the
signature check and the timestamp freshness window before any payload is
trusted — and on the legacy and new-protocol-unencrypted branches, an unknown or
missing **payload** token is a 401 as well. Note the scope: that token rule does
not apply to the encrypted branch, which authenticates through the encrypt-key
signature plus successful decryption alone (§4.1).

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

### 5.3 A failed listener must fail closed — via registry readiness, not config

There are **two** capability notions, and confusing them is how a deployment ends
up advertising something it cannot serve.

| | Determined by | Answers |
|---|---|---|
| **Declared** | `elicitationModes`, computed **in the constructor from config** | "is this build/config configured to be able to deliver a form?" |
| **Live** | the channel registry's readiness bookkeeping | "did a form-capable channel actually start right now?" |

Constructor config decides the **declared** half only. It cannot decide the live
half, because a bind can fail *after* construction — `EADDRINUSE`, a port already
taken, a permissions error — and nothing in the config knows that at that point.

The live half is a separate mechanism, and it is what actually makes a bind failure
fail closed:

```text
FeishuChannel.start() throws (e.g. EADDRINUSE)
  → MessageChannelRegistry records the channel in failedStartupChannels
    (channel-registry.ts:132-136, inside a `finally` so it is recorded AS IT
    HAPPENS rather than after a barrier that may never come)
  → a readiness listener corrects the bridge's capability flag immediately
    (run-console.ts:332-335)
  → auditCapability derives the broken set as DECLARED minus LIVE
    (run-console.ts:354-359)
  → some form channel still live → log elicit_form_degraded and continue
  → no form channel live        → log elicit_form_lost and REFUSE STARTUP
    (run-console.ts:369-388)
```

That last step is fatal **regardless of `channelStartupPolicy`**, deliberately: the
daemon has already told the bridge form elicitation is available, the bridge told
the agent, and that flag is baked into the runtime at construction. Correcting it
afterwards would need a capability-update channel the bridge protocol does not
have, so the only honest alternatives are to refuse the run or to run while lying.

**Operator consequence:** a bind failure is loud. You get a startup failure naming
the channel, not a daemon that starts fine and then cancels every elicitation with
no visible cause.

**And it stays loud even when it happens late:** the readiness signal never
resolves on success, so a Feishu bind that fails hundreds of milliseconds after a
clean audit still fails the run (`run-console.ts:390-398`). A promise that resolved
on success would have closed that window permanently.

Removing `cardActions` from the config is the *other* direction — an operator
deliberately declaring "this account is not form-capable". It works through the
declared half, and it is **not** the mechanism that keeps a bind failure truthful.

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
| No form appears at all and the elicitation is cancelled as unrenderable | request contains a multi-select field (§8) |

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
