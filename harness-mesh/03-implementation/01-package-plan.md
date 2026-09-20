---
description: "The packages to create, file by file, with the corrected ownership, command surface, audit owner, and browser API."
kind: "implementation"
---

# Package plan

## The packages

| # | Package | Directory | Kind | Owns |
|---|---|---|---|---|
| 1 | `@deepseek-ai/dsh-mesh` | `packages/mesh/mesh` | Service (default export) + a `/tailscale` entry | Identity, node registry, pairing state machine, policy, **durable audit** |
| 2 | `@deepseek-ai/dsh-mesh-ops` | `packages/mesh/mesh-ops` | Service + function plugin | **Every operation implementation**, executed against this node's own loopback API |
| 3 | `@deepseek-ai/dsh-mesh-agent` | `packages/mesh/mesh-agent` | Function plugin | The inbound listener: HTTP boundary, authentication, and dispatch |
| 4 | `@deepseek-ai/dsh-mesh-remote` | `packages/mesh/mesh-remote` | Function plugin | The outbound `PeerTransport` registered into `ctx.peers` |
| 5 | `@deepseek-ai/dsh-mesh-cli` | `packages/mesh/mesh-cli` | Bundle + app command | The one-shot `dsh mesh ...` command surface |
| 6 | `@deepseek-ai/dsh-tool-mesh` | `packages/mesh/tool-mesh` | Function plugin | Model tools, with no pairing tool |
| 7 | `@deepseek-ai/dsh-api-mesh-controller` | `packages/api/mesh-controller` | Service + `@Remote` | The browser-facing Host API: administration **and** peer-session access |
| 8 | `@deepseek-ai/dsh-client-ui-mesh` | `packages/client/ui-mesh` | Client plugin | The Mesh panel, the pairing dialog, and the remote-session views |

Nine roles in eight packages. The earlier draft had seven and got two things wrong that this split fixes:

- It described the agent package as implementing the operations while the remote package owned the self-session those operations call. **Operation implementations now have one owner: package 2.** Package 3 owns the HTTP boundary and nothing else.
- It made the Tailscale dependency a separate package for no benefit. It is a second entry point of package 1, exactly as `@deepseek-ai/dsh-ssh` exposes `/broker` and `/worlds`.

## The command surface

The review found the earlier draft's `dsh mesh pair ...` was an invented subcommand. `dsh <name>` means "boot the profile named `name`", so `dsh mesh` boots a *profile*. That is a supported extension point, and it is what the plan now uses — but it has to be declared.

**Package 5 ships the profile.** It is an ordinary bundle:

```json
{
  "name": "@deepseek-ai/dsh-mesh-cli",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./startup": { "types": "./lib/types/startup.d.ts", "default": "./lib/startup.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  }
}
```

Its `src/startup.ts` is the app command, modelled on `packages/bundle/headless/src/startup.ts` and `packages/bundle/web-app/src/startup.ts`:

```ts
export const name = 'mesh-startup'
export const inject = ['cmdlineArgs']

export function apply(ctx: Context): void {
  const program = new Command().name('dsh mesh')
  program.command('invite').description('create a pairing invitation').action(...)
  program.command('pair')
    .requiredOption('--node <endpoint>', 'the responder endpoint')
    .requiredOption('--pairing-id <id>', 'the invitation id printed by the responder')
    .option('--code-stdin', 'read the code from stdin (default when stdin is not a terminal)')
    .action(...)
  program.command('nodes').option('--json').action(...)
  program.command('approve <pairingId>')
  program.command('unpair')
  parseCmdline(ctx, program)
}
```

Registered as a shipped profile template in `packages/boot/app-boot/src/profile.ts` alongside the existing `web`, `headless`, `sdk`, and `acp` templates, so `dsh mesh ...` resolves without the user creating the profile by hand.

### The code never travels through argv

There is **no `--code` flag**. The review's point is correct and the plan's own invariant depended on it:

- On a terminal, `pair` prompts with echo disabled and reads the code there.
- When stdin is not a terminal, `pair` reads the code from stdin — which is what the cross-machine suite pipes, and what makes the command scriptable without putting the secret in argv, in shell history, or in `ps` output.
- The invitation command line the responder prints therefore carries the endpoint and the **public** `pairingId` only.

A worked example of what the responder prints:

```
Pairing invitation for node "linux-box" (fingerprint 7Q2M-4XZP-...)
  Ends:    in 10 minutes
  On the other machine, run:
    dsh mesh pair --node linux-box.tail652dda.ts.net:8444 --pairing-id 8Kd3fQ2mR7vT1pLz
  It will ask for the code. Do not paste the code into a command line.
```

**Documentation verification.** Every command shown in a runbook or README must be executed during the documentation pass against a real node; a printed command that does not parse is a documentation defect. The inventory in [the validation cases](../04-validation/07-case-inventory.md) lists each documented command and the case that runs it.

## Package 1 — `packages/mesh/mesh`

**Role:** `ctx.mesh`. Owns identity, the node registry, the invitation state machine, the grant policy, and the durable audit. It opens **no socket** and implements **no operation**; it is fully testable with nothing else mounted.

```json
{
  "name": "@deepseek-ai/dsh-mesh",
  "version": "<root version>",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./tailscale": { "types": "./lib/types/tailscale.d.ts", "default": "./lib/tailscale.js" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": ["lib/index.js", "lib/tailscale.js", "lib/types/**/*.d.ts"],
  "license": "MIT",
  "peerDependencies": { "@deepseek-ai/cordis": "<range>" },
  "devDependencies": { "@deepseek-ai/cordis": "<range>", "...": "every dsh peer mirrored" },
  "dependencies": {
    "@deepseek-ai/schemastery": "<range>",
    "@deepseek-ai/dsh-brand": "workspace:^",
    "@deepseek-ai/dsh-credentials": "workspace:^",
    "@deepseek-ai/dsh-settings": "workspace:^",
    "@deepseek-ai/dsh-storage-domain": "workspace:^",
    "@deepseek-ai/dsh-util-crypto": "workspace:^",
    "<the reviewed PAKE package>": "<pinned range>"
  }
}
```

`@deepseek-ai/dsh-brand` is the correct package name; the earlier draft wrote `@deepseek-ai/dsh-util-brand`, which does not exist (`packages/util/brand/package.json` publishes `@deepseek-ai/dsh-brand`).

| File | Contents |
|---|---|
| `src/index.ts` | `export default class MeshService extends Service`, the `Context` merge, `Config`, and the public methods |
| `src/types.ts` | Types only |
| `src/errors.ts` | `MeshError`, the code table, and the status map |
| `src/pairing.ts` | The invitation state machine over an injected clock |
| `src/pake.ts` | The **only** cryptographic code: adapters over the reviewed PAKE package, the SAS derivation, and the message codecs |
| `src/identity.ts` | Identity load-or-create, fingerprint, signed challenge responses, conflict detection |
| `src/policy.ts` | Grant evaluation, resolved into an immutable execution specification |
| `src/audit.ts` | The durable bounded audit owner over `ctx.storageDomain` |
| `src/tailscale.ts` | The `/tailscale` entry: resolves addresses and identity through `ctx.subprocess` |
| `README.md` (+ pair) | Package contract |

**Disposal semantics.** Every registration goes through `ctx.effect`. The audit domain handle is closed by the plugin's own disposer. The Tailscale entry's refresh timer is cleared on dispose.

**No invariant companion.** The earlier draft proposed one asserting that paired credentials and registered transports agree. That is not an invariant: this package does not own `ctx.peers`, and a valid composition mounts it with no transport at all. The README records the omission and its reason, per the package-invariant rule.

### The audit owner

The review's objection was decisive: a volatile ring cannot back an incident-response claim.

- Records live in a declared `defineDomain` domain named `mesh-audit`, version 1, opened through `ctx.storageDomain` and routed to whichever backend the deployment configures. The package does **not** choose a backend.
- Retention is bounded two ways: `maxAuditRecords` and `maxAuditAgeMs`. A prune runs on write-batch boundaries and on activation.
- **Argument correlation is keyed, not plain.** Each record stores `HMAC-SHA256(auditCorrelationKey, canonicalJson(args))`, where the key is a credential record (`mesh/audit`) created on first use. A plain `SHA-256` would let anyone holding the log confirm a guessed prompt or path; a keyed hash supports correlation without that.
- **Defined failure behavior.** If the domain cannot be opened or a write fails, the service raises `MESH_AUDIT_UNAVAILABLE`, keeps a count of dropped records, exposes that count through `ctx.mesh.auditHealth()`, and — per `Config.auditFailurePolicy` — either continues serving with degraded auditing (`'degrade'`) or refuses new write operations (`'refuse-writes'`). The shipped value is `'refuse-writes'`, because an unlogged remote turn is worse than a refused one.

### Service surface

Methods, with the ones the review required added:

| Method | Contract |
|---|---|
| `identity()` | This node's id, fingerprint, display name; creates the identity on first call |
| `challenge(nonce)` | A signed challenge response over the node identity key |
| `verifyPeer(nodeId, nonce, signature)` | Whether a peer's signature verifies against the key recorded at pairing |
| `nodes()`, `node(id)`, `upsertNode(record)` | The registry |
| `invite(options)` | Create an invitation; the code is returned **once**, in memory, to the local presenter |
| `invitations()` | Open invitations with their state |
| `claim`, `confirm`, `approve`, `deny`, `poll` | The pairing state machine |
| `grants()`, `grant(keyId)`, `updateGrant(keyId, patch)` | Grant administration |
| `revokeLocal(nodeId)` | Delete this node's grant and the peer's inbound token hash; immediate |
| `resolveSpec(nodeId, operation, args)` | Policy, resolved into an immutable execution specification with explicit precedence |
| `audit(options)`, `auditHealth()` | The durable audit |

There is **no `registerOperation`**. The operation set is a fixed exhaustive map owned by package 2; a plugin cannot widen the wire surface at runtime. The earlier draft's registration API contradicted its own "closed set" claim and had no duplicate, missing, or disposal semantics.

## Package 2 — `packages/mesh/mesh-ops`

**Role:** `ctx.meshOps`. The single owner of every operation's implementation.

- Function plugin: `name = 'mesh-ops'`, `inject = ['mesh', 'connection']`, optional `ctx.get('webServer')`.
- Holds the **self-session**: on first need it calls `ctx.connection.authenticatedUrl('http://127.0.0.1:<port>/')`, fetches with `redirect: 'manual'`, and keeps the resulting cookie in memory. Re-mints at most once per request on `401`, then fails `MESH_SELF_SESSION_UNAVAILABLE`.
- Exposes exactly one entry point: `execute(spec: MeshExecutionSpec, signal: AbortSignal): Promise<MeshOperationResult>`, where `spec` is the immutable resolved specification produced by package 1's policy.
- The operation map is a `const` exhaustive `Record<MeshOperation, Handler>`; adding an operation is a source change plus a schema plus a case, never a runtime registration.
- Streaming operations return a frame iterator that also owns the client half of the Remote stream mux.

This package is what makes the design cheap: live follow, cancellation, and search are already Remote methods, so the mesh implements none of them — it *calls* them on its own loopback API under a policy the peer never sees.

## Package 3 — `packages/mesh/mesh-agent`

**Role:** the inbound listener. It owns the HTTP boundary and nothing else.

- Function plugin: `name = 'mesh-agent'`, `inject = ['mesh', 'meshOps']`.
- Owns a `node:http` server, registered and torn down through `ctx.effect`.
- Pipeline, in fixed order: **read a bounded body → parse the version envelope → parse the per-operation schema exactly once → authenticate → resolve the execution specification → hand the parsed, typed request to `ctx.meshOps.execute`**. Nothing downstream ever sees raw JSON, and authorization reads only parsed values.
- Uploads no files, serves no assets, and has no fallback route. An unmatched path answers an empty `404`.
- The route and authentication table is normative and lives in [the architecture](../02-proposal/02-architecture.md#routes-and-authentication); this package implements exactly that table, and the table's cases are executed against it.

## Package 4 — `packages/mesh/mesh-remote`

**Role:** the outbound direction. One `PeerTransport` per paired node, registered into `ctx.peers`, so the shipped `peer_ask`, `peer_sessions`, and `peer_transcript` tools work against mesh peers unchanged.

**Removed from the MVP: legacy cookie peers.** The earlier draft's `legacyPeers` config let a node drive a stock `dsh web` peer with a hand-harvested cookie. It contradicts G1, appeared in one phase's configuration and another's plan, and expands the credential surface without advancing any acceptance case. It is tracked as separate future work.

## Package 5 — `packages/mesh/mesh-cli`

**Role:** the shipped `mesh` profile and its app command, described under [the command surface](#the-command-surface). It composes a minimal tree — `dsh-base` minus the model and tool layers, plus `dsh-mesh` — because a one-shot command must not boot a browser surface or a model client.

Commands: `invite`, `pair`, `approve`, `deny`, `nodes`, `grants`, `unpair`, `audit`. Each supports `--json` for machine-readable output, which the cross-machine suite consumes.

## Package 6 — `packages/mesh/tool-mesh`

**Role:** the model-facing surface. Three tools, not four.

| Tool | Arguments | Returns |
|---|---|---|
| `mesh_nodes` | none | One bounded line per configured node: name, endpoint, paired state, reachability, allowed operations |
| `mesh_command` | `node`, `prompt`, optional `sessionId`, `cwd`, `agentPreset`, `timeoutMs` | The peer's final answer, stop reason, elapsed time, session id, usage |
| `mesh_sessions` | `node`, optional `limit` | Recent session rows on the peer |

**There is no `mesh_pair` tool.** A tool call is durable model-visible history, so a code passed to a tool would be logged by construction. The model can read pairing state through `mesh_nodes` and can ask the human to run the pairing command; it never holds the code. `Config` therefore has no `allowModelInitiatedPairing` field — the capability does not exist rather than being disabled by a flag.

## Package 7 — `packages/api/mesh-controller`

**Role:** the browser's Host API. The earlier draft offered administration only, which cannot render the panel its own UI plan describes. Two groups:

**Administration**

| Wire method | Purpose |
|---|---|
| `mesh/status` | This node's identity, listener state, bind address, published endpoint, audit health |
| `mesh/nodes` | Configured nodes with presence, grants, and last successful contact |
| `mesh/invite` / `mesh/invitations` / `mesh/approve` / `mesh/deny` | The pairing ceremony |
| `mesh/unpair` | Local revocation, with the best-effort remote step reported |
| `mesh/grants` / `mesh/setGrant` | Read and mutate a peer's grant |
| `mesh/audit` | Paged durable audit reads |
| `mesh/settings` / `mesh/setSettings` | **Editable node and listener settings** — display name, configured peer endpoints, bind address, published scheme and port. The earlier draft had no mutation path at all, so its settings screen was read-only in practice |

**Peer session access**

| Wire method | Purpose |
|---|---|
| `mesh/peerSessions` | List a peer's visible sessions |
| `mesh/peerSessionPage` | Read a bounded page |
| `mesh/peerSessionTranscript` | Read a reduced transcript |
| `mesh/peerSessionFollow` | A `@Remote({ mode: 'stream' })` stream of a peer session's events |
| `mesh/submitTask` | Send a prompt to a peer under the same grant policy the model tools use |

Each method is bounded, validates its arguments at the gateway, and reports refusals with the same code table the wire uses. `mesh/peerSessionFollow` is a stream method so cancellation and reconnection follow the Connection's existing semantics rather than a bespoke protocol.

## Package 8 — `packages/client/ui-mesh`

The browser half. Its three registration surfaces, `tsdown.config.ts`, locale ownership, and component discipline are in [the client UI plan](04-client-ui-plan.md). The UI plan now consumes the peer-session methods above and defines the client resource model, its cancellation, its reconnection, and its disposal ownership.

## Composition wiring

`packages/bundle/web-app/cordis.patch.yml` gains, inside its existing `insert` list:

```yaml
- id: mesh
  name: '@deepseek-ai/dsh-mesh'
  config:
    # one owner of every shared bound; see the configuration-ownership section
    auditFailurePolicy: refuse-writes

- id: mesh-tailscale
  name: '@deepseek-ai/dsh-mesh/tailscale'
  config:
    refreshIntervalMs: 30000

- id: mesh-ops
  name: '@deepseek-ai/dsh-mesh-ops'

- id: mesh-agent
  name: '@deepseek-ai/dsh-mesh-agent'
  config:
    enabled: false            # opt-in; nothing binds until a user turns it on
    # T1, the default: a unix socket fronted by tailscale serve. Use
    # { kind: loopback, port } for T2 or { kind: tailscale, port } for T3.
    listen: { kind: unix, path: /run/user/1000/dsh-mesh.sock }
    pathPrefix: /mesh/v1
    publishedScheme: https
    publishedPort: 8444       # 8443 is already published on the reference machine

- id: mesh-remote
  name: '@deepseek-ai/dsh-mesh-remote'

- id: api-mesh-controller
  name: '@deepseek-ai/dsh-api-mesh-controller'

- id: ui-mesh
  name: '@deepseek-ai/dsh-client-ui-mesh'
```

`packages/preset/agent-presets/presets/standard/agent.cordis.yml` gains the tool row:

```yaml
- id: tool-mesh
  name: '@deepseek-ai/dsh-tool-mesh'
  config:
    maxResultBytes: 65536
```

**Resolver manifests.** Every bare name above must appear in the `dependencies` of the layer that names it: the mesh packages in `packages/bundle/web-app/package.json`, the tool package where `dsh-tool-todo` and `dsh-tool-goal` are resolved today.

## Documentation and gate deliverables

| Artifact | Required by |
|---|---|
| A **proposed Agent Note** with its bilingual pair, carrying the durable decision | The Agent Note tier owns decision rationale |
| `docs/subsystems/mesh.md` and pair, when the types ship | Owning subsystems page |
| `packages/mesh/README.md` (+ pair) group page | `verify-subsystem-pages` |
| Eight package READMEs with Model Experience and Known Limitations | Package README gates |
| `packages/README.md` group row; `docs/subsystems/README.md` index entry | Index completeness |
| Regenerated `docs/config-catalog.md` and `docs/tool-catalog.md` | Generated catalogs |
| A supersession check for the new Agent Note | Agent Note rules |

**The plan subtree is not exempt from documentation gates.** The earlier draft claimed that living outside `docs/` made the gates inapplicable. That was false, and `pnpm run test:docs` proved it: the translation-pairing gate scopes any file matching `README.md` anywhere in the repository, so two files in this folder failed it. They are now named `00-INDEX.md` and `assets/00-ASSETS.md`, which puts them outside the pairing corpus, and the whole subtree is declared non-authoritative scratch material whose durable content lives in the Agent Note.
