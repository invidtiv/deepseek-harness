---
description: "Types, per-operation wire schemas, configuration ownership, error codes, and the Cordis-facing API of every mesh package."
kind: "implementation"
---

# Types, configuration, and service API

## Brands

```ts
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable identity of one Harness installation, minted once per $DSH_HOME. */
export type MeshNodeId = Branded<'MeshNodeId'>

/** Hex SHA-256 of a node's Ed25519 identity public key. */
export type MeshFingerprint = Branded<'MeshFingerprint'>

/** Opaque bearer credential issued by one pairing handshake. */
export type MeshToken = Branded<'MeshToken'>

/** Identifier of one issued credential; carried by the token so a server can classify a failure. */
export type MeshKeyId = Branded<'MeshKeyId'>

/** Public identifier of one pairing invitation; never secret. */
export type MeshPairingId = Branded<'MeshPairingId'>
```

The import path is `@deepseek-ai/dsh-brand`. An earlier draft wrote `@deepseek-ai/dsh-util-brand`, which does not exist.

## The node record

The earlier draft's two allowlists were documented backwards, and its single `lastSeenAt` conflated a failed attempt with a success. Both are fixed:

```ts
/** One configured peer Harness, paired or merely configured. */
export interface MeshNodeRecord {
  readonly nodeId: MeshNodeId
  readonly fingerprint: MeshFingerprint
  readonly displayName: string
  /** MagicDNS name without the trailing dot, when known. */
  readonly tailscaleName: string | undefined
  /** Endpoint this node dials, host and port. */
  readonly endpoint: string
  readonly scheme: 'http' | 'https'
  readonly state: 'configured' | 'pairing' | 'paired' | 'revoked' | 'incomplete'
  readonly protocols: readonly string[]
  /**
   * Operations THIS node permits the peer to call on us.
   * Advertised to the peer as its inbound permission.
   */
  readonly allowedInbound: readonly string[]
  /**
   * Operations THIS node is permitted by the peer to call.
   * Learned from the peer's advertisement; never authoritative locally.
   */
  readonly allowedOutbound: readonly string[]
  readonly pairedAt: number | undefined
  /** Time of the last contact attempt of any outcome. */
  readonly lastAttemptAt: number | undefined
  /** Time of the last contact that succeeded. Presence derives from THIS field only. */
  readonly lastSuccessAt: number | undefined
  readonly online: boolean
  /** SAS both humans confirmed, kept for later comparison. */
  readonly confirmedSas: string | undefined
  readonly protocol: string | undefined
  /** The peer's long-term public key, recorded at pairing and used to verify challenges. */
  readonly peerPublicKey: string | undefined
}
```

**Presence rule.** `online` is derived from `lastSuccessAt` and the configured failure threshold. A reachable node whose only replies are errors is offline, not online.

## The grant

```ts
/** What one paired peer may do on this node. Non-secret; stored in settings. */
export interface MeshGrant {
  readonly version: 1
  readonly keyId: MeshKeyId
  readonly peerNodeId: MeshNodeId
  readonly peerFingerprint: MeshFingerprint
  /** Operation names; `session.*` globs are permitted. `*` alone is refused by validation. */
  readonly allow: readonly string[]
  /** Absolute roots a request may NAME as cwd. NOT a confinement mechanism. */
  readonly cwdRoots: readonly string[]
  /** Agent presets a peer may select. */
  readonly presets: readonly string[]
  /**
   * The permission preset or execution world a remote turn runs under.
   * Required whenever `allow` contains a write operation; the plugin refuses to
   * load a composition that grants writes without it.
   */
  readonly confinement: { readonly kind: 'permission-preset' | 'execution-world'; readonly id: string } | undefined
  readonly maxPromptBytes: number
  readonly maxConcurrentTurns: number
  readonly maxTurnsPerHour: number
  readonly maxStreamSeconds: number
  readonly maxResponseBytes: number
  readonly approval: 'never' | 'always'
  readonly expiresAt: number | undefined
  readonly createdAt: number
  readonly lastUsedAt: number | undefined
}
```

## Credential record payloads

The earlier draft's token ownership was reversed: it had the responder mint a token for the initiator, when the party that **mints** a token is the one that must **present** it. The corrected rule, applied throughout:

> **The side that will present a token mints it and keeps it. The side that will verify it stores only its hash, keyed by `keyId`.**

```ts
/** This node's own identity. */
export interface MeshIdentityPayload {
  readonly version: 1
  readonly nodeId: MeshNodeId
  /** base64url PKCS#8 Ed25519 private key. */
  readonly privateKey: string
  readonly publicKey: string
  readonly displayName: string
  readonly createdAt: number
}

/** A token this node PRESENTS to one peer, kept in cleartext because it must be sent. */
export interface MeshOutboundPayload {
  readonly version: 1
  readonly peerNodeId: MeshNodeId
  readonly peerFingerprint: MeshFingerprint
  readonly keyId: MeshKeyId
  readonly token: MeshToken
  readonly protocol: string
  readonly pairedAt: number
}

/** A token a peer PRESENTS to this node. Only the hash is kept. */
export interface MeshInboundPayload {
  readonly version: 1
  readonly peerNodeId: MeshNodeId
  readonly keyId: MeshKeyId
  /** SHA-256 of the peer's token, base64url. */
  readonly tokenHash: string
  readonly issuedAt: number
  readonly expiresAt: number | undefined
  /** Set while a re-pairing supersedes this key, so the old key stays valid for a bounded window. */
  readonly supersededAt: number | undefined
}

/** Local key for keyed audit correlation. Never leaves the node. */
export interface MeshAuditKeyPayload {
  readonly version: 1
  /** base64url 32 random bytes. */
  readonly key: string
  readonly createdAt: number
}
```

## The immutable execution specification

The review found the same bound declared in several packages with no stated precedence. There is now **one resolver** and one immutable value:

```ts
/** Everything an operation executor needs, resolved once, frozen, and never re-read from config. */
export interface MeshExecutionSpec {
  readonly operation: MeshOperation
  readonly peerNodeId: MeshNodeId
  readonly keyId: MeshKeyId
  /** Parsed, typed arguments. No downstream code sees raw JSON. */
  readonly args: MeshOperationArgs
  readonly limits: MeshLimits
  readonly cwdRoots: readonly string[]
  readonly presets: readonly string[]
  readonly confinement: MeshGrant['confinement']
  readonly approval: 'never' | 'always'
  readonly traceId: string
  readonly hops: number
  readonly visited: readonly string[]
  readonly idempotencyKey: string | undefined
}

/** Effective bounds for one request. Every field is the most restrictive of the three sources. */
export interface MeshLimits {
  readonly promptBytes: number
  readonly concurrentTurns: number
  readonly turnsPerHour: number
  readonly streamSeconds: number
  readonly streamBytes: number
  readonly responseBytes: number
  readonly timeoutMs: number
}
```

**Precedence rule, stated once:** for every bound, the effective value is `min(node default, grant value, request value)`. A request may lower a bound and never raise it. `ctx.mesh.resolveSpec()` performs the reduction and `Object.freeze`s the result; `ctx.meshOps.execute()` takes only a spec and never consults configuration. This is the "explicit > implicit at package boundaries" rule applied to limits: defaulting happens in the resolver, not inside the executor.

## Per-operation wire schemas

The earlier draft typed arguments as `unknown` and left parsing rules to each handler. Every operation now has a normative request and response schema, parsed **exactly once** at the HTTP boundary.

Rules that apply to all of them:

1. **Unknown fields are rejected**, not ignored. A peer that sends a field this version does not know is running a different protocol, and silently dropping it would hide that.
2. **Numbers are bounded and integral** where they are counts or byte sizes; a fractional or out-of-range value is a validation failure, not a coercion.
3. **Strings are bounded in bytes, not characters**, and validated against a per-field maximum before any allocation.
4. **Canonical encoding for hashing**: the audit correlation hash is taken over the parsed value re-serialized with sorted keys and no insignificant whitespace, so two spellings of the same request correlate.
5. **Response envelopes are bounded too.** `responseBytes` is enforced on the complete encoded response — list, page, search, transcript, tool result, and error envelope alike — with an explicit truncation marker, not only on prompts and streams.

| Operation | Request fields | Response fields | Notable bounds |
|---|---|---|---|
| `node.status` | none | identity, fingerprint, protocols, listener state, allowed-outbound, audit health | fixed size |
| `session.list` | `cursor?`, `limit?` | `items[]` with sessionId, title, cwd, running, updatedAt | `limit <= 200`; `responseBytes` |
| `session.read` | `sessionId`, `throughSeq?`, `beforeSeq?`, `maxMessages?` | `records[]`, `hasMore` | `maxMessages <= 200`; `responseBytes` |
| `session.transcript` | `sessionId`, `limit?`, `maxCharsPerMessage?` | `messages[]` role and text | `limit <= 200`, `maxCharsPerMessage <= 8192`; `responseBytes` |
| `session.follow` | `sessionId`, `fromSeq?` | opening snapshot, then `event` frames, then a terminal frame | `streamSeconds`, `streamBytes`; a per-frame size cap |
| `session.search` | `query`, `limit?` | `items[]`, `hasMore` | `query <= 1024` bytes, `limit <= 100`; `responseBytes` |
| `session.create` | `cwd?`, `agentPreset?`, `workspaceId?` | `sessionId`, `agentPreset?` | `cwd` must be absolute and inside `cwdRoots`; preset must be allowed |
| `session.prompt` | `sessionId`, `mode`, `content[]`, `requestId` | `accepted` | `promptBytes`; the session must exist and its **recorded** cwd must satisfy policy |
| `session.cancel` | `sessionId` | `accepted` | the session must be one the grant covers |
| `task.ask` | `prompt`, `cwd?`, `agentPreset?`, `sessionId?`, `timeoutMs?` | `sessionId`, `answer?`, `stopReason`, `elapsedMs`, `usage?` | `promptBytes`, `timeoutMs <= node ceiling`, `responseBytes` |

**Authorization reads only parsed values.** A denial never depends on a raw string that a later stage would interpret differently — the class of bug that made the earlier draft's `cwdRoots` check both bypassable and misleading.

## Configuration ownership

Every bound has exactly one declaring package. The earlier draft declared presence interval, prompt bytes, concurrency, and hourly budget in three packages at once.

| Package | Owns | Explicitly does not own |
|---|---|---|
| `dsh-mesh` | `displayName`, `invitationTtlMs`, `maxAttemptsPerInvitation`, `maxOpenInvitations`, pairing rate limits, `presenceIntervalMs`, `presenceFailureThreshold`, `maxHops`, grant defaults (`defaultAllow`, `defaultLimits`), audit bounds and `auditFailurePolicy` | Listener, transport, tool presentation |
| `dsh-mesh-ops` | `selfSessionRefreshMaxRetries`, `operationTimeoutMs` ceiling | Any grant-scoped bound |
| `dsh-mesh-agent` | `enabled`, **`listen`** (a discriminated union; see below), `publishedScheme`, `publishedPort`, `pathPrefix`, `maxRequestBodyBytes`, `auditUnauthenticated` | Presence, budgets, grants, approval |
| `dsh-mesh-remote` | `requestTimeoutMs`, `askTimeoutMs`, `reconnectBackoffMs`, `reconnectBackoffMaxMs`, `registerWithPeers` | Presence interval; it consumes the one `dsh-mesh` declares |
| `dsh-tool-mesh` | `maxResultBytes`, `maxCommandBytes`, `defaultCommandTimeoutMs` | Peer policy |
| `dsh-api-mesh-controller` | `maxPageSize`, `maxAuditPageSize`, `followIdleTimeoutMs` | Peer policy |
| `dsh-mesh-cli` | none; it reads `dsh-mesh` | — |

A bound that a deployment must vary and that appears in two packages is a defect, not a convenience.

### The listener's bind target

The three supported topologies are three distinct bind targets, so the field is a discriminated union rather than an address string that may or may not be valid:

```ts
/**
 * Where the listener binds. Each variant is one supported topology, so an
 * invalid combination is unrepresentable rather than rejected at request time.
 */
export type MeshListen =
  /** T1, the default: a unix socket fronted by tailscale serve. No local TCP port exists. */
  | { readonly kind: 'unix'; readonly path: string }
  /** T2: loopback, fronted by serve. Any local process can reach it and forge advisory headers. */
  | { readonly kind: 'loopback'; readonly port: number }
  /** T3: this node's own Tailscale address. The peer address is authentic. */
  | { readonly kind: 'tailscale'; readonly port: number }
```

Validation at load:

- `kind: 'tailscale'` requires an address inside `100.64.0.0/10` or `fd7a:115c:a1e0::/48`; anything else fails with `MESH_BIND_NOT_TAILSCALE`.
- `kind: 'unix'` creates the socket with mode `0600`, refuses a path that already exists and is not a socket, and removes the socket file on dispose. The path must be absolute.
- `kind: 'loopback'` accepts only `127.0.0.1` or `::1`.
- Every variant reports a taken port or path as `MESH_PORT_IN_USE` and names the conflict.

An earlier revision declared `bindAddress` and `port` only, which made **T1 inexpressible** and left the default topology unimplementable. The union fixes that, and the separate identity-source field the earlier revision carried disappears with it: the topology is now derivable from the bind target, so it is not a second field a deployment could set inconsistently.

## `dsh-mesh` service API

| Method | Contract |
|---|---|
| `identity()` | This node's id, fingerprint, display name; creates the identity on first call |
| `challenge(nonce)` | A signature over a caller-supplied nonce under the node identity key |
| `verifyPeer(nodeId, nonce, signature)` | Whether a peer's signature verifies against the key recorded at pairing |
| `nodes()`, `node(id)`, `upsertNode(record)` | The registry |
| `invite(options)` | Create an invitation; the code is returned once, in memory, to the local presenter |
| `invitations()` | Open invitations with their state |
| `claim(pairingId, initiator)`, `confirm(...)`, `approve(pairingId)`, `deny(pairingId)`, `poll(...)` | The pairing state machine |
| `grants()`, `grant(keyId)`, `updateGrant(keyId, patch)` | Grant administration |
| `revokeLocal(nodeId)` | Delete this node's grant and the peer's inbound hash; immediate |
| `resolveSpec(peerNodeId, keyId, operation, args)` | Policy, resolved into a frozen {@link MeshExecutionSpec} |
| `audit(options)`, `auditHealth()` | The durable audit |

**There is no `registerOperation`**, and there is no address-provider registry. The address provider is an ordinary optional service consumed with `ctx.get('meshAddresses')`, which is the repository's stated pattern for optional capabilities and needs no duplicate, missing, or disposal semantics of its own.

### Events

```ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A node record was created or changed.
     * @param node - The current record after the change.
     * @mode emit
     */
    'mesh/node-updated'(node: MeshNodeRecord): void

    /**
     * One pairing invitation changed state.
     * @param invitation - The invitation after the transition.
     * @mode emit
     */
    'mesh/invitation'(invitation: MeshInvitationView): void

    /**
     * One cross-node request was admitted, denied, or failed.
     * @param record - The audit record describing it.
     * @mode emit
     */
    'mesh/audit'(record: MeshAuditRecord): void

    /**
     * Admit or refuse one inbound request after authentication and parsing.
     * @param spec - The resolved execution specification.
     * @param next - Delegate to the next listener or the executor.
     * @mode waterfall
     */
    'mesh/request'(spec: MeshExecutionSpec, next: () => Promise<void>): Promise<void>
  }
}
```

The waterfall receives the **resolved specification**, so a deployment policy added as a listener sees exactly what the executor will see and cannot be bypassed by a later re-read of configuration.

### Audit record

```ts
/** One audited cross-node interaction. Durable, bounded, and free of content. */
export interface MeshAuditRecord {
  readonly at: number
  readonly direction: 'inbound' | 'outbound'
  readonly nodeId: MeshNodeId
  readonly operation: MeshOperation | 'pair.claim' | 'pair.confirm' | 'pair.poll' | 'pair.approve'
  readonly traceId: string
  readonly outcome: 'allowed' | 'denied' | 'failed'
  readonly reason: MeshErrorCode | undefined
  /** HMAC under the local audit key over the canonical argument encoding. */
  readonly argsCorrelation: string | undefined
  readonly durationMs: number | undefined
  readonly hops: number
  /** Identity a proxy CLAIMED, marked as unverified. Never an authorization input. */
  readonly claimedIdentity: string | undefined
}
```

### The call chain

The earlier draft carried hops and the visited set in HTTP headers, which vanish the moment a peer's model makes its own outbound call. The call chain is therefore **session state**:

- Admitting a remote turn writes a serializable session event `mesh/inbound` carrying `{ traceId, hops, visited, peerNodeId, protocol }`, declared `ignorable: true` so a build that does not know the type skips it rather than refusing the log.
- A `meshCallChain` **session projection** derives `{ hops, visited }` from that event, so the value survives a restart and is replayable from the log.
- `mesh_command` and `mesh/submitTask` read the projection for the **current session** and send `hops + 1` with the current node appended to `visited`. A session with no call chain starts at zero.
- The serving node refuses when `hops >= maxHops` or when its own node id is already in `visited`, before opening any socket.

This is the "model-visible implies logged" rule applied to the call chain: a value that changes what a model request does is reconstructable from the log.

## Error codes

```ts
export type MeshErrorCode =
  // Authentication: one collapsed code for every unauthenticated failure.
  | 'MESH_UNAUTHENTICATED'
  // Authorization, which requires a verifying token and may therefore be specific.
  | 'MESH_NOT_ALLOWED'
  | 'MESH_CWD_DENIED'
  | 'MESH_PRESET_DENIED'
  | 'MESH_CONFINEMENT_REQUIRED'
  | 'MESH_SESSION_DENIED'
  // Request validity.
  | 'MESH_PROTOCOL_MALFORMED'
  | 'MESH_VERSION_UNSUPPORTED'
  | 'MESH_BODY_TOO_LARGE'
  | 'MESH_RESPONSE_TOO_LARGE'
  // Identity and loop control.
  | 'MESH_IDENTITY_CONFLICT'
  | 'MESH_HOP_LIMIT'
  // Capacity and availability.
  | 'MESH_BUSY'
  | 'MESH_UNAVAILABLE'
  | 'MESH_SELF_SESSION_UNAVAILABLE'
  | 'MESH_AUDIT_UNAVAILABLE'
  // Pairing.
  | 'MESH_PAIR_UNKNOWN'
  | 'MESH_PAIR_THROTTLED'
  | 'MESH_PAIR_CONFIRM_FAILED'
  | 'MESH_PAIR_DENIED'
  | 'MESH_PAIR_APPROVAL_TIMEOUT'
  | 'MESH_PAIR_INCOMPLETE'
  // Configuration, raised at load.
  | 'MESH_BIND_NOT_TAILSCALE'
  | 'MESH_PORT_IN_USE'
  | 'MESH_CONFIG_INVALID'
```

**Local-only classifications.** The serving node records these in its own durable audit but never returns them:

- token failures — `token-missing`, `token-unknown`, `token-revoked`, `token-expired`; the caller always sees `MESH_UNAUTHENTICATED`;
- invitation outcomes — `MESH_PAIR_EXPIRED`, `MESH_PAIR_BURNED`, `MESH_PAIR_DENIED`, `MESH_PAIR_COMMITTED`; the caller always sees `MESH_PAIR_UNKNOWN`.

This is what makes the failure-oracle rule in the threat model achievable while keeping the local record useful. `MESH_PAIR_EXPIRED` is deliberately absent from the wire code list above, and an earlier revision carried it in both places.

## Deliberately absent

- No `connect()` returning a live handle; operations are addressed by node id each time.
- No streaming result on the outbound `ask`; streaming is the separate `session.follow` operation with its own grant.
- No runtime operation registration.
- No model-initiated pairing, and no configuration flag pretending to disable it.
- No legacy cookie peer mode in the MVP.
- No rotation operation; see [the security runbook](../05-operations/02-security-runbook.md#rotation).
