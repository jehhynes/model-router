# model-router

A local HTTP router that sends Claude Code and Codex model calls to [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) while both clients stay signed in with their subscription logins (claude.ai and ChatGPT). Features gated on the subscription login, such as Claude Code's dictation button in VS Code, stay available, and model calls go through CLIProxyAPI. Features that depend on what CLIProxyAPI returns are not covered by that.

## How it works

Each listener has model paths and an optional passthrough upstream:

- A request whose path is a model path, or under one, goes to the model upstream. The router removes the client's `authorization`, `x-api-key`, `chatgpt-account-id` and `cookie` headers and sends `Authorization: Bearer <apiKey>`.
- Any other request goes to the passthrough upstream with its end-to-end headers unchanged, or gets a 404 when the listener has no passthrough.
- The request target is forwarded as received, so the router and the upstream see the same path. A target that is not a path gets a 400.
- Responses from the model upstream lose their subscription limit headers (`anthropic-ratelimit-unified-*`, `x-codex-primary-*`, `x-codex-secondary-*`, `x-codex-credits-*`, `x-codex-active-limit`, `x-codex-rate-limit-*`, `x-codex-limit-name`, `x-codex-promo-*`), and model WebSocket connections lose their `codex.rate_limits` messages, because the clients would apply the upstream account's limits to their own login. Model WebSocket upgrades are sent without `Sec-WebSocket-Extensions`, so messages arrive uncompressed and can be read. Codex 0.163.0 ignores `codex.rate_limits` events in SSE streams, so the router does not filter those.
- A 401 or 403 from the model upstream becomes a 502 naming the upstream, because the clients would otherwise treat it as their own login failing and refresh or prompt for sign-in.
- Streamed responses and WebSocket upgrades are relayed as they arrive. When the upstream closes a response early, the client's response is closed too.

The router listens on 127.0.0.1 only.

### What each client sends to its base URL

Observed with Claude Code 2.1.304 and Codex CLI 0.163.0:

| Client | Requests to the base URL | Everything else |
|---|---|---|
| Claude Code, signed in to claude.ai, `ANTHROPIC_BASE_URL` set | `HEAD /api/hello`, `POST /v1/messages?beta=true` with the claude.ai OAuth token | Direct to `api.anthropic.com` and `claude.ai` |
| Codex, ChatGPT login, `openai_base_url` set | `GET /v1/models`, WebSocket `GET /v1/responses`, then `POST /v1/responses`, with the ChatGPT token and `chatgpt-account-id` | Direct to `chatgpt.com` |

Claude Code reports `authMethod: "claude.ai"` in `claude auth status` only when `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` are unset. `ANTHROPIC_BASE_URL` alone does not change it.

## Configuration

[config.json](config.json) holds the listeners. The CLIProxyAPI client keys go in `.env` in the repository root, which git ignores; copy [.env.example](.env.example).

| Field | Meaning |
|---|---|
| `logFile` | File the router appends one line per request to, relative to the repository root; stdout when omitted |
| `listeners[].name` | Name shown in the log |
| `listeners[].port` | Port on 127.0.0.1 |
| `listeners[].passthrough` | Upstream for non-model paths, or `null` for 404 |
| `listeners[].model.upstream` | CLIProxyAPI origin, without a path |
| `listeners[].model.apiKeyEnv` | Name of the `.env` variable that holds the CLIProxyAPI client key |
| `listeners[].model.paths` | Path prefixes routed to the model upstream; `/v1/messages` matches itself and `/v1/messages/...`, and `/v1/` matches everything under it |

## Install

Requires Node 22 or later.

- Windows: run `pwsh -File install/windows.ps1` from an elevated PowerShell. It registers the `model-router` scheduled task, which runs at logon as your account without a window (S4U, which needs the "Log on as a batch job" right that administrators have) and restarts the router 5 seconds after it exits, then waits until the router listens. `-Uninstall` removes it.
- Linux: `install/linux.sh` installs and starts the `model-router.service` systemd user service, with the absolute path of the `node` on your PATH. `--uninstall` removes it.

## Client configuration

Claude Code, in `~/.claude/settings.json`, with no `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`:

```json
"env": {
  "ANTHROPIC_BASE_URL": "http://127.0.0.1:8318"
}
```

Codex, in `~/.codex/config.toml`, with the built-in `openai` provider and a ChatGPT login:

```toml
model_provider = "openai"
openai_base_url = "http://127.0.0.1:8319/v1"
```

## Test

```sh
npm test
```

The tests use loopback upstreams only.
