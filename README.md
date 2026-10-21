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

`config.json` in the repository root holds the listeners; copy [config.json.example](config.json.example), which sends model calls to CLIProxyAPI on `127.0.0.1:8317`, and change the upstreams if CLIProxyAPI runs elsewhere. The CLIProxyAPI client keys go in `.env`; copy [.env.example](.env.example). Git ignores both files.

| Field | Meaning |
|---|---|
| `logFile` | File the router appends one line per request to, relative to the repository root; stdout when omitted |
| `logMaxBytes` | Largest size of the log file, a whole number from 1 to 9007199254740991; default 10485760 (10 MB). Before a line would take the file past it, the file becomes `<logFile>.1`, the previous `.1` becomes `.2`, and so on. A line larger than the limit is still written, to an empty file |
| `logMaxFiles` | Number of those older files to keep, a whole number from 0 to 1000; default 5. Older ones are deleted, and 0 deletes the full log file. If the log file cannot be renamed, for example because another program on Windows holds it open, the router keeps appending to it and tries again with the next line |
| `listeners[].name` | Name shown in the log |
| `listeners[].port` | Port on 127.0.0.1 |
| `listeners[].passthrough` | Upstream for non-model paths, or `null` for 404 |
| `listeners[].model.upstream` | CLIProxyAPI origin, without a path |
| `listeners[].model.apiKeyEnv` | Name of the `.env` variable that holds the CLIProxyAPI client key |
| `listeners[].model.paths` | Path prefixes routed to the model upstream; `/v1/messages` matches itself and `/v1/messages/...`, and `/v1/` matches everything under it |

## Install

Requires Node 22 or later.

- Windows: run `pwsh -File install/windows.ps1` from an elevated PowerShell. It registers the `model-router` scheduled task, which runs at logon as your account without a window (S4U, which needs the "Log on as a batch job" right that administrators have) and restarts the router 5 seconds after it exits, then waits until the router listens. `-Uninstall` removes it.
- Linux: `install/linux.sh` installs and starts the `model-router.service` systemd user service. The service runs `install/run.sh`. With nvm installed (in `NVM_DIR` at install time, `~/.nvm` by default), it uses the `node` that nvm's default alias names, or the newest installed `node` when that alias names a removed version, so installing or removing Node versions with nvm does not break it while at least one Node 22 or later stays installed. Without nvm it uses the absolute path of the `node` that was on your PATH at install time. Paths containing `& | \ " ' % $ @` or line breaks are not supported. `--uninstall` removes it.

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
