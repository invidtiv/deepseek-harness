---
description: "Verified map of the DeepSeek Harness surfaces this plan builds on: plugin model, web server, /api trust and authentication, session storage, the peer control plane, the SDK, webhook, and SSH."
kind: "research"
---

# DSH internals that constrain a cross-machine plugin

Every fact below was read from source in this checkout or produced by a command on this machine. Paths are repository-relative. Anything marked **Assumed** is not verified here.

## 1. The Web surface and what it actually exposes

`dsh web` is `dsh --profile web` (`apps/cli/src/args.ts`). The profile at `$DSH_HOME/profiles/web/` composes two bundles in order — `@deepseek-ai/dsh-base`, then `@deepseek-ai/dsh-web-app` — then the profile's own `cordis.patch.yml`, then any `--patch` overlays.

The HTTP carrier is `packages/host/webserver`. Its `Config` schema accepts exactly two host literals:

```ts
host: z.union([z.const('127.0.0.1'), z.const('0.0.0.0')]).required(),
port: z.natural().max(65535).required(),
```

There is **no TLS field anywhere in the harness's server stack**: `WebServer[Service.init]` calls `node:http`'s `createServer` and `listen(port, host)`. No certificate, no key, no proxy or `X-Forwarded-*` interpretation. TLS has to be terminated by something in front of it.

Two indirections matter for a mesh plugin:

- `ctx.webServer.register({ kind: 'exact' | 'prefix', path, handler })` for routes; **one** `registerFallback` seat, claimed by the shipped frontend-static owner. A new plugin must claim a distinct path prefix, not the fallback.
- `ctx.webServer.registerUpgrade({ path, handler })` for HTTP upgrade sockets. The gateway already owns `/api/remote.mux` this way, so a WebSocket-based mesh channel would need its own exact path.

### What is authenticated, and what is not

Verified route owners and their access control:

| Path | Owner | Authentication |
|---|---|---|
| `/api` (prefix) | `packages/client/connection/src/index.ts` | Host/Origin fence, then browser-session cookie |
| `/api/remote.mux` (upgrade) | `packages/api/gateway/src/index.ts` | Same rejection path, then `rejectRemoteStreamUpgrade` |
| `/open-in-app/*` | `packages/host/open-in-app/src/index.ts` | `requestRejection` |
| `/plugins` (prefix) | `packages/client/modules/src/index.ts` | **none** |
| `/plugins/events` (SSE) | `packages/client/hmr/src/index.ts` | **none** |
| webhook routes | `packages/webhook/webhook-github/src/index.ts` | HMAC of the request body |
| fallback (dist assets) | `packages/host/frontend-static/src/index.ts` | index calls `authorizeIndex`; **other assets are public** |

**Consequence for this plan.** Anything reachable on the mesh port must be authenticated by the mesh plugin itself. Do not assume the harness's existing fence protects a new route: it is applied only where a route owner calls it.

## 2. The /api trust fence and the cookie, exactly

`packages/client/connection/src/api-request-trust.ts` exports `isTrustedApiRequest(request, trustedHosts)`. Its header comment is explicit that it is a browser-trust fence, not an auth layer. The order:

1. `host` header must parse. Hostname must be loopback (`localhost`, `[::1]`, `127.0.0.0/8`) or match a `trustedHosts` entry.
2. `sec-fetch-site: cross-site` is refused outright.
3. If `origin` is present it must equal the Host. `Origin: null` is refused.

`trustedHosts` entries are validated at plugin load by `assertTrustedAuthority`: a bare canonical `host` or `host:port`. A port-less entry matches the hostname on any port; an entry with a port matches that exact authority. Path, userinfo, zero-padded port, percent-encoding, and non-punycode IDN fail the load.

`HostConnectionService.requestRejection()` returns `403` when the fence fails and `401` when the fence passes but the browser session does not.

The browser session, in `packages/client/connection/src/browser-auth.ts`:

- Cookie name is `dsh-auth-` + base64url(sha256(authority)), where authority is the normalized `host[:port]`.
- Value is `v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256(secret, body))>`, payload `{version, authority, issuedAt, expiresAt}`, compared with `timingSafeEqual`.
- Attributes: `Max-Age`, `Path=/`, `Expires`, `HttpOnly`, `SameSite=Strict`. **No `Secure`, no `Domain`.**
- The HMAC secret is a `GrantRecord` at credential key `client-connection/browser-session`, created on first activation, persisted by `packages/credentials/credentials-local` into `$DSH_HOME/.credentials.yaml`.
- Minting path: the process launch token, a 32-byte base64url value held in a `WeakMap` on the root context. It is accepted **only** on `GET /` with exactly one `?token=` query parameter, which answers `303` with `set-cookie` and `location: /`. The token is never persisted and changes every process start.

Two properties drive the whole design:

- **Cookies are authority-bound.** A cookie minted for `127.0.0.1:3080` is invalid for `box.tailnet.ts.net:443`, because both the name and the signed payload bind the authority. `packages/peer/peer-remote/README.md` states the consequence: one peer reached at two addresses needs two credentials.
- **There is no headless mint.** `packages/client/connection/README.md` states the carrier accepts no query token outside the root exchange and no `Authorization` header token. `packages/credentials/authorization` exists, but it is a human-in-the-loop flow registry (`registerFlow`, `begin`, `cancel`), not a programmatic token issuer.

This is the single largest gap the mesh plugin closes: today, pairing two harnesses means a human opening a browser on machine A, navigating to machine B's URL, and copying a cookie value into an environment variable.

## 3. The existing peer control plane

`packages/peer/` is a capability seam with the standard three roles, decided in `.agents/notes/implemented/feature/2026-09-12-peer-harness-control-plane.md`:

| Package | Role | Provides |
|---|---|---|
| `peer/peer` | Service Definition | `ctx.peers`: registry plus `listSessions`, `ask`, `transcript` |
| `peer/peer-remote` | Transport | one peer per plugin row, speaking the Remote API over HTTP |
| `peer/tool-peer` | Consumer | model tools `peer_ask`, `peer_sessions`, `peer_transcript` |

`PeerTransport` is the extension point a mesh transport implements:

```ts
interface PeerTransport {
  readonly id: string
  listSessions(signal?: AbortSignal): Promise<readonly PeerSessionSummary[]>
  ask(request: PeerAskRequest, signal?: AbortSignal): Promise<PeerAskResult>
  transcript(request: PeerTranscriptRequest, signal?: AbortSignal): Promise<readonly PeerMessage[]>
}
```

`register(transport)` routes through `ctx.effect` and returns a disposer, so unloading a transport row removes exactly that peer. Selection fails loud: `NO_PEER`, `AMBIGUOUS_PEER`, `DUPLICATE_PEER`, `SERVICE_DISPOSING`.

`RemotePeerTransport` (`packages/peer/peer-remote/src/remote.ts`) posts `{ type: 'client-request', rpcId, method, payload: { args } }` to `<baseUrl>/api/<namespace>/<method>` with a `cookie` header and `redirect: 'error'`, and accepts only a matching `{ type: 'server-response', rpcId, result }`. It uses four endpoints: `session/create`, `session/prompt`, `session/list`, `session/page`. Completion is polled: it records the session's log cursor from `session/list` projection `asOfSeq`, admits the prompt, then polls until a `turn/end` appears after that cursor.

**No shipped `cordis.yml` mounts any peer package.** Composition is entirely opt-in.

The decision record also rejected two things this plan must not reintroduce:

- Binding the peer's web surface to all interfaces — *that exposes remote code execution to the network*.
- Driving the peer over SSH stdio — no session listing, no transcript reads, a forced command per call.

## 4. Session storage on disk

Verified layout under `$DSH_HOME/sessions/`:

```
<encoded-cwd>/<session-uuid>/session.v3.jsonl.zstd
<encoded-cwd>/<session-uuid>/session.jsonl.zstd      # older format generation
```

The working directory is encoded into the directory name; this machine's checkout appears as `--C-Users-tiaz-Desktop-Github-deepseek-harness--`. The format generation is in the filename, so older and newer logs coexist. Logs are zstd-compressed JSONL and grow large: observed files on this machine range from 38 KB to 887 KB.

There is a derived index under `$DSH_HOME/storages/session_projcache/` plus `session_projcache.json`, and `$DSH_HOME/storages/workspace.json`.

**Consequence.** A session log is owned by the machine that hosts the session. A shared directory (NFS, SMB, Syncthing, Dropbox) is not a supported transport: two harness processes must never append to one log, and the derived caches would diverge silently. The mesh shares sessions by *serving* them from the owner, never by *mounting* them.

## 5. Adjacent surfaces and why they are not the answer

| Surface | What it does | Why it is not the mesh |
| --- | --- | --- |
| `packages/sdk/*` | Newline-delimited JSON-RPC 2.0 over `Readable`/`Writable`; production wiring is `process.stdin`/`process.stdout`. Methods `initialize`, `session/prompt`, `shutdown`; notifications `session.event`, `session.status`, `subagent.started`, `subagent.finished` | **Stdio only.** A grep of `packages/sdk` for `listen(`, `createServer`, `net.`, `http.`, `socket` matches only test-local fakes. `subagent-dsh-sdk`'s own README: local child processes only — a remote runtime would need its own backend. |
| `packages/subagent/subagent-dsh-sdk` | One fresh local child per run, `inheritsParentContext = false`, `dshHome` required absolute | Same stdio limit. Useful as the *model* for a mesh-driven remote child later. |
| `packages/webhook/webhook` + `webhook-github` | HMAC-verified inbound `POST`, then `Agent.followup()` | One-way, GitHub-shaped (`delivery.kind === 'github'`), no result, no queue, no dedup, no cancel. A generic inbound adapter would be a separate package. |
| `packages/ssh/*` | `fs-ssh` to `ctx.fs`, `subprocess-ssh` to `ctx.subprocess`, `sandbox-ssh` to `ctx.sandbox`; terminals, LSP, PTC | Remote *execution*, not harness linking. The agent loop, model transport, session storage, and approvals stay local. Excellent for the **test harness**, not for the product feature. |
| `packages/experimental/agent-team` | Teammates of a Lead in **one process**; mailbox is a replay projection of the Lead's log | README: one process and one shared checkout; not cross-process exactly-once. |
| `packages/telegram/*`, `bundle/telegram-bundle` | An out-of-browser surface | A chat bridge, not a peer link. |

## 6. Configuration surfaces a mesh plugin must integrate with

- **Credentials.** `ctx.credentials` is the seam. `credentialKey(scope, id)` produces `<scope>/<id>`. Two key spaces: `CredentialRef` (a POSIX env-var name, resolvable) and `CredentialKey` (a record id; presence is the fact). `modifyRecord` is the only correct write path, because a correct write depends on the current value under one lock. Providers layer as inherited env, then stored file, then project `.env`, then `$DSH_HOME/.env`; an empty stored value is absent everywhere.
- **Settings.** `$DSH_HOME/settings.yaml` holds named namespaces such as `ssh-environments`. A mesh node list belongs in a settings namespace so the Plugins page can edit it; the *secrets* belong in credentials.
- **Home paths.** `packages/util/home-paths` resolves `$DSH_HOME` with precedence: explicit configured path, then `$DSH_HOME`, then `~/.dsh`. An empty or whitespace-only `$DSH_HOME` counts as unset. On this Windows machine the home is `C:/Users/tiaz/.dsh`; on Linux and macOS it is `~/.dsh`.

## 7. What the harness gives a new plugin for free

- `ctx.effect()` for every registration, so unloading a row removes exactly its contribution.
- The Loader's `!!js` tag in `cordis.yml` for expressions, evaluated only after injected services exist. `packages/bundle/web-app/cordis.patch.yml` uses this to defer bind-dependent values to `webStartup` and `webRuntime`.
- HMR with per-entry reconciliation.
- `ctx.subprocess` for running `tailscale` as a child process, with a scrubbed environment available through `scrubbedParentEnv()`.

## Gaps this plan must close

1. **No headless credential.** Pairing must mint one without a browser.
2. **No non-loopback bind.** The mesh listener must be its own server, because `ctx.webServer`'s schema has no address for a Tailscale interface.
3. **No discovery.** Peers are declared in composition and never probed.
4. **No live session stream.** `peer-remote` polls and returns a settled result.
5. **No grants model.** The peer credential grants whatever the peer's Remote API grants; the note itself warns that a leaked cookie becomes unattended execution.
6. **No loop protection.** Nothing stops node A asking node B which asks node A.
