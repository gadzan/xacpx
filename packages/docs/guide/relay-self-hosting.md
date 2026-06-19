# Self-Hosting the Relay Hub

The **relay hub** is an optional, self-hosted server that turns xacpx into a multi-tenant remote-control dashboard. Your xacpx instances dial **out** to the hub over WebSocket and register; you then log in to a web dashboard from any browser and drive every instance's sessions — chat, scheduled tasks, and orchestration — from one place.

This guide walks an operator from nothing to a running hub with a paired instance.

## Architecture at a glance

```
   xacpx instance A ─┐                         ┌─ browser (token login)
   xacpx instance B ─┤  WSS (dial-out)         │  HTTPS + WSS
   xacpx instance C ─┴──────────────►  RELAY HUB  ◄───────────┘
                       :8788 instance gateway   :8787 HTTP API + web /ws
                                  │
                              relay.db (SQLite)
```

- **Two ports.** The HTTP API and the dashboard's `/ws` fan-out share **8787**; the **instance** WebSocket gateway (where xacpx instances register) is **8788**. They are separate so you can firewall them independently.
- **Multi-tenant.** Every token-user only ever sees its own instances and sessions; the server stamps identity on each proxied call. Tokens, instance credentials, and web-session cookies are stored hashed.
- **Source of truth stays on the instances.** The hub caches recent messages for the dashboard but does not own your sessions — the instances do.

## Requirements

- **Node.js ≥ 22.13** (uses the built-in `node:sqlite`) **or Bun ≥ 1.2** (uses `bun:sqlite`). No native database addon to compile.
- A host reachable by your instances and your browser. For anything beyond localhost you want a TLS-terminating reverse proxy (see [TLS & reverse proxy](#tls-reverse-proxy)).
- To pair instances, each instance needs the `xacpx` CLI (the normal install from [Getting Started](/guide/getting-started)).

## 1. Get the server

Install the relay hub globally. The web dashboard ships **embedded inside the package**, so this one install is everything you need — no separate dashboard build, no `--web-root`:

```bash
npm i -g @ganglion/xacpx-relay
```

This puts the `xacpx-relay` binary on your `PATH`. The bundled dashboard is auto-detected at startup; the `start` command prints its resolved path (shown below).

::: details Run from source instead (development / contributing)
Clone the repo and build the server — `build:relay` also builds the dashboard and embeds it into `packages/relay/dist/relay-web`:

```bash
git clone https://github.com/gadzan/xacpx
cd xacpx
bun install && bun run build:relay
```

The entry point is then `packages/relay/dist/cli.js` — run `node packages/relay/dist/cli.js <command>` in place of `xacpx-relay <command>` everywhere below.
:::

## 2. Quickstart (zero flags needed)

Auth is entirely token-based — **no passwords, no admin accounts, no invite flow**. A token IS a user. Mint one and start the server:

```bash
# Step A — create a user + token (DB auto-created at ~/.xacpx-relay/relay.db)
xacpx-relay add token

# Step B — start the server (uses the same default DB; dashboard auto-detected)
xacpx-relay start
```

`add token` prints the token **once**:

```
access token: bBS9nN2W2MwdrdksoLTLrQeMLMah9M5flTOyEcBbIHc
(store it now — not shown again)
hint: use this token for web login AND: xacpx channel add relay --url ws://<host>:<ws-port> --token <token>
```

`start` confirms what is running:

```
xacpx-relay listening: http :8787, instance ws :8788, db ~/.xacpx-relay/relay.db, dashboard: /usr/lib/node_modules/@ganglion/xacpx-relay/dist/relay-web
```

Open `http://<host>:8787`, paste the token into the **Access token** field, and you are in.

## 3. Token management

The hub has exactly **4 CLI commands**; all flags are optional:

### `add token` — create a user + login token

```bash
xacpx-relay add token [--label <note>] [--db <path>]
```

Each call creates an isolated user and prints its access token once. The same token is used to:
1. Log in to the web dashboard (paste into **Access token**).
2. Pair an xacpx instance (`--token <T>` in `channel add relay`).

Reuse the **same** token across multiple instances to group them under one user.

### `ls` — list tokens

```bash
xacpx-relay ls [--db <path>]
```

Shows: short id, label, created date, number of paired instances.

### `rm token` — revoke a token (and its user)

```bash
xacpx-relay rm token <value-or-id> [--db <path>]
```

Deletes the user behind that token and cascades to its instances, web sessions, and cached messages. Revocation kills that token's web sessions on the next request; an already-open dashboard `/ws` socket lingers until reconnect. To hard-cut all sessions: stop the hub, run `sqlite3 <db> "DELETE FROM web_sessions;"`, then restart.

### `start` — start the server

```bash
xacpx-relay start \
  [--db <path>] \
  [--web-root <dir>] \
  [--host 0.0.0.0] \
  [--http-port 8787] \
  [--ws-port 8788] \
  [--history-retention-days 30] \
  [--request-timeout-ms 120000] \
  [--trust-proxy]
```

| Flag | Default | Purpose |
|---|---|---|
| `--db <path>` | `~/.xacpx-relay/relay.db` | SQLite database file. The directory is created automatically. |
| `--http-port <n>` | `8787` | HTTP API **and** the dashboard's `/ws` fan-out. |
| `--ws-port <n>` | `8788` | Instance gateway — where xacpx instances register. |
| `--host <addr>` | `0.0.0.0` | Bind address. |
| `--web-root <dir>` | _(auto-detected)_ | Dashboard assets directory. Auto-resolves the dashboard embedded in the package (`dist/relay-web` next to `cli.js`); only pass this to override. |
| `--history-retention-days <n>` | `30` | Cached messages older than this are pruned hourly (also hard-capped at 2000 messages per session). |
| `--request-timeout-ms <n>` | `120000` | Per-request timeout for proxied calls to instances. |
| `--trust-proxy` | _(off)_ | Trust `X-Forwarded-For` for rate limiting. Pass this when behind a reverse proxy; **never** when directly internet-exposed (it would allow IP spoofing). |

There is no `stop`/`status` subcommand — stop the hub with `Ctrl-C` / `SIGTERM` (run it under systemd, pm2, or Docker for lifecycle management).

::: tip Rate limiting
The hub enforces a per-client-IP rate limit plus a global failure ceiling. When running behind a reverse proxy, pass `--trust-proxy` so the real client IP from `X-Forwarded-For` is used for rate limiting, not your proxy's loopback address.
:::

## 4. Pair an xacpx instance

### Attach the instance

On the machine running the xacpx instance, add the relay connector channel using the **same token** you created in step 2:

```bash
xacpx plugin add @ganglion/xacpx-channel-relay
xacpx channel add relay --url <host> --token <T> [--name home-pc]
xacpx restart
```

`xacpx plugin add` installs the connector from npm and pulls in its `@ganglion/xacpx-relay-protocol` dependency automatically. The instance's `xacpx` core must be **≥ 0.11.0** (the connector's peer requirement).

::: details Pairing from a source checkout (development)
If you run the instance from a repo checkout, the workspace already links `channel-relay` and `relay-protocol` — skip `plugin add` and run `xacpx channel add relay …` directly.
:::

### `--url` shorthand rules

`--url` accepts any of the following; the connector normalizes it to a full WebSocket URL:

| What you pass | Resolved to |
|---|---|
| `relay.example.com` (bare domain) | `wss://relay.example.com` |
| `1.2.3.4` (IP) | `ws://1.2.3.4:8788` |
| `1.2.3.4:9000` | `ws://1.2.3.4:9000` |
| `localhost` | `ws://localhost:8788` |
| `host:9000` | `ws://host:9000` |
| `ws://…` or `wss://…` | used as-is |
| `http://…` or `https://…` | mapped to `ws://…` / `wss://…` |

::: warning IPv6
Bare unbracketed IPv6 addresses are not supported. Use `[::1]:8788` instead.
:::

### How pairing works

On first connect the instance exchanges the access token for a long-lived per-instance credential, written (mode `0600`) to `<xacpx-home>/relay/credential.json`. The `config.json` keeps only the url/name — the token is **never** stored there. The token is used only at first pairing — all subsequent reconnects use the stored credential.

::: tip One token, multiple instances
Reuse the same token on several instances (e.g. `home-pc`, `work-laptop`). They all appear under the same user in the dashboard.
:::

Back in the dashboard, the instance appears in the left column with a green dot once it is online. Select a session to chat; open the task panel (right column, or the **Tasks** button on mobile) for scheduled and orchestration tasks.

## TLS & reverse proxy {#tls-reverse-proxy}

The hub speaks **plain** HTTP and WS. For any non-localhost deployment, terminate TLS at a reverse proxy and forward both the HTTP/web port and the instance-gateway port. Instances should then connect with `wss://`.

The dashboard's live updates use a WebSocket upgrade on the **HTTP port**, so the proxy must allow upgrades on that route as well.

### Caddy

```text
relay.example.com {
    reverse_proxy 127.0.0.1:8787   # HTTP API + dashboard + dashboard /ws (Caddy proxies upgrades automatically)
}

gateway.example.com {
    reverse_proxy 127.0.0.1:8788   # instance gateway; instances use wss://gateway.example.com
}
```

### nginx

```nginx
# Dashboard + HTTP API (port 8787, includes the dashboard /ws upgrade)
server {
    listen 443 ssl;
    server_name relay.example.com;
    # ssl_certificate ...; ssl_certificate_key ...;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}

# Instance gateway (port 8788) — instances connect with wss://gateway.example.com
server {
    listen 443 ssl;
    server_name gateway.example.com;
    # ssl_certificate ...; ssl_certificate_key ...;
    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

### Which ports to expose

| Port | Audience | Expose publicly? |
|---|---|---|
| 8787 | Browsers (dashboard + API + dashboard `/ws`) | Yes, behind TLS |
| 8788 | xacpx instances (gateway) | Yes, behind TLS |
| — | `relay.db` | Never — it is a local file |

## Token & user management

- **More users/instances:** run `add token` again — each call creates an isolated user. Reuse the same token on multiple instances to group them under one user.
- **Audit:** `ls` shows all tokens with their labels, creation dates, and instance counts.
- **Revoke:** `rm token <value-or-id>` removes the user and cascades to its instances, web sessions, and cached messages. The token's web sessions are killed on the next request; open `/ws` sockets linger until reconnect.
- **Force global re-login:** stop the hub, `sqlite3 <db> "DELETE FROM web_sessions;"`, restart.
- **Automatic GC:** an hourly maintenance loop prunes cached messages past `--history-retention-days` (and the 2000-per-session cap) and deletes expired web sessions. No cron needed.

## Persistence & backup

Everything lives in the one SQLite file at `--db` (default `~/.xacpx-relay/relay.db`). To back up, stop the hub (or snapshot during a quiet moment) and copy the file:

```bash
cp ~/.xacpx-relay/relay.db /backups/relay-$(date +%F).db
```

Losing it means losing all token-users, instance registrations, and cached history — instances would need to be re-paired.

## Running under systemd (example)

```ini
# /etc/systemd/system/xacpx-relay.service
[Unit]
Description=xacpx relay hub
After=network.target

[Service]
# Use the absolute path to the installed binary — find it with `command -v xacpx-relay`.
ExecStart=/usr/bin/xacpx-relay start --host 127.0.0.1
Restart=on-failure
User=xacpx

[Install]
WantedBy=multi-user.target
```

Bind to `127.0.0.1` and let your reverse proxy face the internet. The DB and dashboard are auto-detected from their defaults; add `--db` only if you want a non-default path.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Dashboard 404 / blank page | `start` printed `dashboard: (none)` — the embedded UI wasn't found | The dashboard ships inside `@ganglion/xacpx-relay`; reinstall the package. From a source checkout, rebuild with `bun run build:relay` (it embeds the dashboard into `dist/relay-web`). |
| Instance never turns green | Wrong gateway URL or revoked/mistyped token | Check that `--url` resolves to the **8788** gateway (or its `wss://` proxy); re-run `add token` and re-pair if the token was revoked. |
| Custom `--db` not taking effect | `--db` passed inconsistently between commands | Pass the **same** `--db` path to both `add token` and `start`; the default `~/.xacpx-relay/relay.db` is a fixed absolute path so omitting `--db` consistently is safe. |
| Live updates stall behind a proxy | Proxy not forwarding WebSocket upgrades on 8787 | Allow `Upgrade`/`Connection` headers on the dashboard route. |

## See also

- [`docs/relay-module.md`](https://github.com/gadzan/xacpx/blob/main/docs/relay-module.md) — server + connector internals.
- [`docs/relay-web-module.md`](https://github.com/gadzan/xacpx/blob/main/docs/relay-web-module.md) — dashboard architecture.
- Design spec: `docs/superpowers/specs/2026-06-13-relay-hub-design.md`.
