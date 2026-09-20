---
description: "Symptom to cause to fix for the mesh: what a caller learns versus what the durable audit knows, pairing, presence, operations, environment, and the plan's remaining inconsistencies."
kind: "operations"
---

# Troubleshooting

Each entry gives the symptom as a user sees it, the most likely cause in order, and the check that distinguishes them.

## What a caller learns, and what the audit knows

The serving node never tells an unauthenticated caller which authentication case failed. One code covers all of them:

| Caller state | What the caller sees | What the local audit records |
|---|---|---|
| No token presented | `401 MESH_UNAUTHENTICATED` | `token-missing` |
| A token whose `keyId` matches no record | `401 MESH_UNAUTHENTICATED` | `token-unknown` |
| A token deleted by unpair | `401 MESH_UNAUTHENTICATED` | `token-revoked` |
| A token whose grant is past `expiresAt` | `401 MESH_UNAUTHENTICATED` | `token-expired` |

`MESH_TOKEN_REVOKED`, `MESH_TOKEN_EXPIRED`, and `MESH_UNPAIRED` are **not wire codes**. An operator who expects them in a CLI error or a peer's log is reading a pre-review document; the distinction exists only in the serving node's durable audit. Once a token verifies, failures become specific, because the caller has proved which peer it is:

| Class | Codes |
|---|---|
| Authorization | `MESH_NOT_ALLOWED`, `MESH_CWD_DENIED`, `MESH_PRESET_DENIED`, `MESH_CONFINEMENT_REQUIRED`, `MESH_SESSION_DENIED` |
| Request validity | `MESH_PROTOCOL_MALFORMED`, `MESH_VERSION_UNSUPPORTED`, `MESH_BODY_TOO_LARGE`, `MESH_RESPONSE_TOO_LARGE` |
| Identity and loops | `MESH_IDENTITY_CONFLICT`, `MESH_HOP_LIMIT` |
| Capacity and availability | `MESH_BUSY`, `MESH_UNAVAILABLE`, `MESH_SELF_SESSION_UNAVAILABLE`, `MESH_AUDIT_UNAVAILABLE` |
| Pairing | the `MESH_PAIR_*` codes below |
| Configuration, raised at load | `MESH_BIND_NOT_TAILSCALE`, `MESH_PORT_IN_USE`, `MESH_CONFIG_INVALID` |

## Pairing

| Symptom | Likely cause | Check | Fix |
|---|---|---|---|
| `dsh mesh pair` cannot reach the node | Tailscale is down, the listener is off, or `serve` is not publishing | `tailscale status`; the local listener over its socket or port; `tailscale serve status` | Bring Tailscale up; enable the listener; publish the port |
| `MESH_PAIR_UNKNOWN` | Unknown, expired, already delivered, denied, or burned — the responder deliberately collapses all of them | `dsh mesh invitations` on the responder, plus the durable audit | Create a fresh invitation |
| `MESH_PAIR_CONFIRM_FAILED` | Wrong code, or an active relay | Compare the SAS on both screens; if they differ, treat it as an attack and start over | Re-create the invitation; if it recurs with the correct code, investigate the network |
| `MESH_PAIR_THROTTLED` | Too many attempts | The audit's `pair.*` rows | Wait out the window; a burned invitation needs a fresh one |
| `MESH_PAIR_DENIED` | The operator denied it | The responder's UI | Pair again if it was a mistake |
| `MESH_PAIR_APPROVAL_TIMEOUT` | Nobody approved inside the bound | The responder's pending-approval list | Approve within the bound, or re-pair |
| `MESH_PAIR_INCOMPLETE` | An ack never arrived inside the delivery window | Both nodes' audit for the staged record | Re-pair |
| An invitation expired, but the error says `MESH_PAIR_UNKNOWN` | Expected: the caller-facing response is collapsed | The audit's local classification | Create a fresh invitation |
| The code is rejected as malformed | Wrong length, or a character outside the Crockford alphabet | The error text names the position | Re-read the code; `I`/`L` are `1`, `O` is `0`, `U` is `V` |
| A printed command contains `--code 4K7P-2WQN` | Stale documentation | — | There is no `--code` flag: use `dsh mesh pair --node <endpoint> --pairing-id <id>` and answer the masked prompt |

## Presence

| Symptom | Likely cause | Check | Fix |
|---|---|---|---|
| A paired node shows offline but is running | The listener is off while Tailscale is up, or the recorded address is stale | `E-NET-03`: probe the mesh port from the peer | Re-enable the listener; refresh the address from the node list |
| A node never appears | Presence is disabled, or the pairing is incomplete | `presenceIntervalMs` in the composition; the node's state | Set an interval; re-pair |
| A node flaps online and offline | Relay path instability, or an aggressive failure count | `tailscale ping <node>` for a direct-versus-relayed answer | Raise `failuresBeforeOffline` and the backoff ceiling |
| Nodes appear with the wrong name | MagicDNS rename, or a display name changed on the peer | `tailscale status --json`; the peer's own settings | Refresh the node; names are the peer's to choose |

## Operations

| Symptom | Likely cause | Check | Fix |
|---|---|---|---|
| Every call from a paired node is `401 MESH_UNAUTHENTICATED` | The token was revoked on the serving node, the grant record was deleted, or the grant expired | `dsh mesh nodes` and `dsh mesh audit` on the serving node — the audit says which of the four cases it was | Re-pair |
| `MESH_NOT_ALLOWED` | The operation is not in the grant | The allowed-operations list on the node | Add the operation deliberately |
| `MESH_CWD_DENIED` | The requested directory is outside every root | The grant's `cwdRoots` against the requested path | Widen the roots or choose a directory inside them. `cwdRoots` governs the starting directory only; it is not confinement |
| `MESH_CONFINEMENT_REQUIRED` | A write operation is granted with no confining preset named | The grant's `confinement` field | Name a permission preset or execution world, or remove the write operation |
| Remote writes refuse while reads still work | The audit domain is unavailable and `auditFailurePolicy` is `refuse-writes` | `ctx.mesh.auditHealth()`, or `dsh mesh audit` | Restore the audit backend; do not switch the policy to `degrade` to make writes resume |
| `MESH_BUSY` | Concurrency or hourly budget | The audit's recent admitted turns | Wait, or raise the budget deliberately |
| `MESH_HOP_LIMIT` | Two nodes are asking each other | The request's visited set in the audit record | This is the loop guard working; restructure the work so one node owns the task |
| `MESH_UNAVAILABLE` | Network, listener, or self-session failure | The doctor; the peer's log | Restore the network or the listener; if the self-session failed twice, the peer's local server is the problem |
| `MESH_SELF_SESSION_UNAVAILABLE` | The node's own loopback server refused to mint a session | The peer's log for `client-connection` errors | This is a local harness problem, not a mesh one: check that the web profile booted |
| `MESH_PROTOCOL_MALFORMED` | A peer answered with a field this version does not know | Both nodes' protocol versions | Upgrade the older node; report it if the versions match |
| `MESH_VERSION_UNSUPPORTED` | No common protocol version | Both nodes' advertised versions | Upgrade the older node |
| `MESH_IDENTITY_CONFLICT` | A cloned home, or a reimaged machine | Both nodes' fingerprints | Delete the identity on the clone and re-pair |
| A remote session read returns nothing | The session is on the peer but not shared, or the id is unknown | `mesh_sessions` against that node | The peer's own list is authoritative |
| A live follow never delivers | The turn never ends, or the stream cap closed it | The stream's end reason | Raise `maxStreamSeconds`, or inspect the peer's turn |

## Environment

| Symptom | Likely cause | Check | Fix |
|---|---|---|---|
| The plugin fails to load with `MESH_BIND_NOT_TAILSCALE` | a `listen` of kind `tailscale` does not name an address in `100.64.0.0/10` or `fd7a:115c:a1e0::/48` | The configured value | Use loopback with `tailscale serve` (T1 or T2), or this node's own Tailscale address (T3) |
| `MESH_PORT_IN_USE` | Another process holds the port — relevant only under T2 and T3, since T1 binds a socket | `ss -ltnp` on Linux, `Get-NetTCPConnection` on Windows | Stop it or change the port in both the composition and the `serve` mapping |
| Serve answers 502, or its log says it cannot dial the backend under T1 | The socket path is wrong, or the socket's mode excludes the `tailscaled` user | `ls -l <socketPath>`; `tailscale serve status` | Point the `serve` mapping at the real socket; fix the mode; verify the listener is running |
| An unexpected identity appears in the audit under T2 | Expected: any local process can connect to the loopback port and write advisory headers | The audit record's claimed identity, which is marked unverified | Nothing to fix — this is why no header is an authorization input |
| `tailscale whois` refuses under T3 | It needs root or the configured operator | The command's own error | Treat `whois` as optional corroboration, not a dependency |
| `tailscale serve` rejects a PROXY protocol option | PROXY protocol is supported only for TCP forwarding; it is rejected for HTTP/HTTPS and unsupported with a unix socket target | The mapping's options | Remove the option; the real peer address is not available to the backend this way |
| The doctor reports a stale address | The node re-registered with a new IP | `tailscale status --json` against the descriptor | Update the descriptor from the tailnet, which is what the doctor's fix line says |
| `tailscale cert` fails | HTTPS certificates are disabled for the tailnet | The admin console | Use T3 (direct tailnet bind); never Funnel |
| The Funnel warning fires | A mesh port is published publicly | `tailscale funnel status` | `tailscale funnel --https=<port> off` |
| Every request is `401` from a machine that was just paired | The clock is badly skewed, or the credential write failed | Both clocks; the credential file for the `mesh/peer/*` record | Fix the clock; re-pair if the record is missing |
| Requests work from the node itself but not from the peer | `serve` is not publishing, or an ACL blocks the published port | `tailscale serve status`; the tailnet ACL policy | Publish the port; adjust the ACL |
| An operation works over HTTP but a follow does not | A proxy or `serve` is not passing the upgrade | The stream's failure reason | Check the `serve` mapping; the upgrade path must reach the listener |

## Diagnosing from another node

```bash
# Is the machine on the tailnet at all?
tailscale ping <node>

# Is the mesh listener answering the one unauthenticated route?
curl -sS --max-time 5 https://<node>.<tailnet>.ts.net:<publishedPort>/mesh/v1/hello | jq

# Under T1, the same route on the node itself, over its socket.
curl -sS --max-time 5 --unix-socket <socketPath> http://localhost/mesh/v1/hello | jq

# Is the GUI accidentally exposed? It must refuse.
curl -sS --max-time 3 http://<node-tailscale-ip>:3080/ || echo refused

# Is anything Funnel-exposed?
tailscale funnel status

# What did the node decide? The collapsed 401 plus its local classification.
ssh <ssh-name> 'dsh mesh audit --limit 50 --json'
```

Under T1 and T2 the audit's claimed identity is a claim, because the observed peer is the local proxy. Only under T3 is the observed source address worth corroborating with `tailscale whois`.

## Corrections that landed after this folder was first written

These were inconsistencies across the plan, found while writing this runbook. All are now resolved in the documents themselves; the table records what changed so an operator reading an older copy knows which statement to trust.

| Document | What it used to say | Now |
|---|---|---|
| `04-validation/03-cross-machine-e2e.md` `E-DENY-03` | Expected a distinct `MESH_TOKEN_EXPIRED` on the wire | One collapsed `MESH_UNAUTHENTICATED`; the distinction is local to the serving node's audit |
| `02-proposal/02-architecture.md` failure model | Listed `MESH_UNPAIRED`, `MESH_TOKEN_EXPIRED`, and `MESH_TOKEN_REVOKED` as wire codes | Those are local classifications, not wire codes |
| `02-proposal/02-architecture.md` topologies | Used an earlier T1/T2/T3 labelling | T1 unix socket, T2 loopback, T3 direct tailnet bind, as in [the Tailscale runbook](01-tailscale-runbook.md) |
| `04-validation/05-acceptance-criteria.md`, `03-implementation/04-client-ui-plan.md` | Showed `dsh mesh pair --node <addr> --code <code>` | The command carries `--node` and `--pairing-id`; the code is read from a masked prompt or stdin |
| `04-validation/03-cross-machine-e2e.md` `E-PAIR-04` | Expected `410 MESH_PAIR_EXPIRED` | `404 MESH_PAIR_UNKNOWN`: every non-open invitation outcome collapses to one response, and `MESH_PAIR_EXPIRED` is a local classification |
| `assets/nodes.json`, `assets/provision-linux.sh` | Modelled a loopback TCP backend publishing `:8443` | T1 unix socket, published on **8444**, because `:8443` is already published on the reference machine |
| `03-implementation/02-types-and-config.md` | Declared `bindAddress` and `port` for `dsh-mesh-agent` | Declares a discriminated `listen` union, so T1 is expressible |
| `05-operations/02-security-runbook.md` | Documented a `dsh mesh rotate` command | There is no rotation operation; rotation is unpair plus re-pair |

## What to include when reporting a problem

The mesh's own artifacts, in this order, and nothing that could carry a secret:

1. `dsh mesh nodes --json` output with node ids and fingerprints — these are public identifiers.
2. The failing operation's error code and message, and the audit record's local classification for the same request.
3. The audit records for the failing window — they carry no prompts and no paths.
4. The doctor's output.
5. Both nodes' protocol versions and the harness version.
6. The topology in use (T1, T2, or T3) and the relevant `serve` mapping.

Never include the code from an open invitation, a token, a cookie, or the contents of `.credentials.yaml`. The pairing code in particular has no legitimate place in a log, a ticket, a URL, an error message, or a metrics label.

## Repository checks

The plan subtree is not exempt from the repository's documentation gates, and this folder is no exception:

- `pnpm run test:docs` must stay green (`pnpm run doc-sync` is the full gate).
- No file in this folder may be named `README.md`. The translation-pairing gate matches `readme.md` at any depth outside dependency and generated trees (`scripts/translation-pairing.ts`, `README_ARTIFACT`), so a `README.md` here would be pulled into the bilingual pairing corpus and fail the gate. That is why the folder's index is `00-INDEX.md` and the assets index is `assets/00-ASSETS.md`.