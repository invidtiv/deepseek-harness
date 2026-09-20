---
description: "Wire specification for the mesh pairing handshake: SPAKE2 per RFC 9382, invitation lookup, bidirectional credential commit, and lifecycle."
kind: "proposal"
---

# Pairing protocol

Protocol identifier: `dsh-mesh/1`. This is the safe pairing-code flow.

## Design in one paragraph

The responder creates a single-use invitation and shows a short code to its human. The initiator is told that code by the human, over a channel the network never sees. Both sides then run **SPAKE2 (RFC 9382)** with the code as the password over the edwards25519 ciphersuite, exchanging ephemeral messages that carry no offline verifier. Both humans compare a short authentication string derived from the agreed key, the responder approves, and each side hands the other a durable bearer token **sealed under that key**. The code never crosses the wire and never appears in a command line.

## Why this changed

An earlier version of this protocol used a plain X25519 exchange with the code mixed into an HKDF afterwards. **That construction is rejected.** A captured transcript from it can be attacked offline against all 2^40 codes, and no amount of short-authentication-string comparison removes that; the SAS only detects an *active* relay, not an *offline* crack of a recorded session.

SPAKE2 removes the offline verifier entirely: an eavesdropper who records every message and knows the protocol gains nothing checkable without guessing the ephemeral secret. The earlier plan deferred this to an optional hardening phase. It is now mandatory in v1, because a pairing protocol that leaks an offline verifier is not a pairing protocol.

## Roles and terms

| Term | Meaning |
|---|---|
| **Responder (B)** | Creates the invitation, displays the code, approves. Chaotic-order identity `B` in the RFC's notation. |
| **Initiator (A)** | Receives the code from the human. |
| **Code** | 8 Crockford base32 symbols, 40 bits, shown as `XXXX-XXXX`. Out-of-band secret. |
| **SAS** | 6 decimal digits derived from the SPAKE2 key. Compared by both humans. |
| **pairingId** | Random 128-bit invitation identifier. **Public**, and required by every message. |
| **token / keyId** | The durable bearer credential each side mints for itself, and its identifier. |

## Primitives and dependencies

| Purpose | Primitive | Source |
|---|---|---|
| PAKE | SPAKE2, RFC 9382, **edwards25519 + SHA-256 + HKDF-SHA256 + HMAC-SHA256**, transcript identities A = initiator node id, B = responder node id | `@noble/curves` (group, point arithmetic, and the RFC 9382 edwards25519 M/N constants are published in RFC 9382 §6, so **no hash-to-curve is needed**) |
| Password hardening | scrypt over the code before it becomes the SPAKE2 scalar `w` | `node:crypto`, no new dependency |
| Key derivation | HKDF-SHA256 | `@noble/hashes` |
| Confirmation tags | HMAC-SHA256, compared with `timingSafeEqual` | RFC 9382's `cA` / `cB` |
| Sealing the tokens | AES-256-GCM | `node:crypto` |
| Node identity | Ed25519 signing over the handshake transcript | `@noble/curves` |

### Dependency selection, stated for review

`@noble/curves` at the version pinned in `package.json`: MIT, ESM with TypeScript types, Cure53-audited with a published security policy, and among the most-depended-on JavaScript cryptography libraries in existence. It supplies the group and point arithmetic; **SPAKE2 itself is implemented in `src/pake.ts`** against the RFC, because no maintained npm package implements SPAKE2 over edwards25519 and the alternatives are worse:

- `spake2` (last published 2019) and `@niomon/spake2` (2022) are unmaintained CJS packages with no types and four transitive crypto dependencies each.
- libsodium is a ristretto255 *primitive* provider with **no PAKE**; both `spake2` and PAKE symbols are absent from its surface.
- `@serenity-kit/opaque` is the only npm PAKE with a real third-party whitebox audit. It is the **wrong protocol family** here: OPAQUE is an *augmented* PAKE whose purpose is protecting a stored registration record. This flow stores nothing, and OPAQUE would introduce the registration ceremony and the stored record that the review objected to. RFC 9382 §7 says as much: applications needing augmentation should use OPAQUE, and SPAKE2 does not support it.

**Fallback, named for the reviewer:** if a third-party-audited PAKE binary is a hard requirement, `@serenity-kit/opaque` is the candidate, and the price is a registration ceremony plus a stored record whose combination with the server setup *is* an offline verifier for a 40-bit code. That trade is stated rather than assumed.

**Lockfile note.** `@noble/curves` pins `@noble/hashes` exactly, and the repository already carries `@noble/hashes@2.3.0` through `packages/experimental/webworker-runtime`. Adopting it will produce two copies in the lockfile unless a `pnpm.overrides` entry aligns them. That decision belongs in the same pull request as the dependency.

### The password hardening step

RFC 9382 requires the application to define how the shared secret becomes the scalar `w`, and recommends a memory-hard function. The protocol fixes it:

```
w = scrypt(
      password = normalize(code),                  // 8 Crockford symbols, canonical form
      salt     = "dsh-mesh/1/w" || pairingId,
      N = 32768, r = 8, p = 1, dkLen = 64
    ) interpreted as a little-endian integer, reduced modulo L (the edwards25519 group order)
w == 0 is rejected and the handshake fails
```

These parameters are **protocol constants, not configuration**. A deployment-varying cost parameter is a security parameter a deployment could weaken, so changing any of them is a protocol version change, not a config edit.

## The invitation

The responder generates, in memory only:

```
pairingId = 16 random bytes, base64url
code      = 8 symbols from the Crockford alphabet "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
x         = SPAKE2 initiator-side ephemeral scalar  (RFC 9382 B-side: y)
expiresAt = now + invitationTtlMs        (default 600000)
```

A restart invalidates every open invitation. That is correct, and the UI says so rather than showing a stale countdown.

### What the responder prints

```
Pairing invitation for node "linux-box" (fingerprint 7Q2M-4XZP-...)
  Code:      4K7P-2WQN
  Ends:      in 10 minutes
  On the other machine, run:
    dsh mesh pair --node linux-box.tail652dda.ts.net:8444 --pairing-id 8Kd3fQmR7vT1pLz
  It will ask for the code. Do not paste the code into a command line.
```

Three things are corrected from the earlier draft:

1. **The `pairingId` is in the command.** The first message must name the invitation, and the earlier draft's printed command omitted it, so the documented flow could not be executed at all.
2. **There is no `--code` flag.** The code is read from a masked terminal prompt, or from stdin when stdin is not a terminal. It cannot reach shell history, `ps` output, or a process-inspection tool.
3. **No model tool accepts the code.** A tool call is durable model-visible history, so a code passed to one would be logged by construction.

## The handshake

Five messages. The responder is the first verifier, which is what makes "a wrong code burns the invitation" implementable.

### Message 1 — A → B: `POST /mesh/v1/pair/start`

```json
{
  "protocol": "dsh-mesh/1",
  "pairingId": "8Kd3fQmR7vT1pLz",
  "pA": "base64url(32)",
  "initiator": {
    "nodeId": "n_2f9c...",
    "displayName": "windows-dev",
    "fingerprint": "5T3A-9BQK-...",
    "identityPublicKey": "base64url(32)",
    "addresses": ["windows-dev.tail652dda.ts.net", "100.122.125.15"]
  },
  "signature": "base64url(64)"
}
```

`signature` is Ed25519 over the length-prefixed transcript prefix, which binds the identity fields to the SPAKE2 message.

B validates in this order:

1. `protocol` is a version B speaks, else `426` `MESH_VERSION_UNSUPPORTED`. The protocol field is checked **before** the invitation and is not a secret, so it is reported normally.
2. Rate limits, else `429`.
3. The invitation exists, is open or claimed, has not expired, and has not been burned. **Every other outcome is the same `404` `MESH_PAIR_UNKNOWN`.** This collapses unknown, expired, already-delivered, denied, and burned into one response, which is the only way to avoid an invitation-existence oracle. The distinction is recorded in B's local audit.

B computes its own `pB` and replies.

### Message 2 — B → A: `200`

```json
{
  "protocol": "dsh-mesh/1",
  "pairingId": "8Kd3fQmR7vT1pLz",
  "pB": "base64url(32)",
  "responder": {
    "nodeId": "n_71ab...",
    "displayName": "linux-box",
    "fingerprint": "7Q2M-4XZP-...",
    "identityPublicKey": "base64url(32)",
    "addresses": ["linux-box.tail652dda.ts.net"],
    "publishedScheme": "https",
    "publishedPort": 8444,
    "topology": "serve"
  },
  "signature": "base64url(64)"
}
```

Both sides now derive, per RFC 9382:

```
K            = SPAKE2 key agreement (never output)
Ke, Ka       = Hash(TT)                                  // TT is the RFC's length-prefixed transcript
KcA, KcB     = KDF(Ka, nil, "ConfirmationKeys" || AAD)
cA           = MAC(KcA, TT)
cB           = MAC(KcB, TT)
sasBytes     = HKDF-SHA256(Ke, salt = pairingId, info = "dsh-mesh/1/sas", 4 bytes)
sas          = (big-endian uint32(sasBytes) mod 1000000), formatted "ddd-ddd"
sealKey      = HKDF-SHA256(Ke, salt = pairingId, info = "dsh-mesh/1/seal", 32 bytes)
```

**Both sides display the SAS now**, before anything else happens. A shows it with "compare this with the other machine and press Enter when they match". B shows it inside the approval dialog, beside the initiator's name, fingerprint, and claimed addresses.

### Message 3 — A → B: `POST /mesh/v1/pair/confirm`

A mints its own token — **the side that presents a token mints it**:

```
keyIdA  = 16 random bytes, base64url
tokenA  = 32 random bytes, base64url
sealedA = AES-256-GCM(sealKey, iv, JSON({ protocol, keyId: keyIdA, token: tokenA,
                                          nodeId: A.nodeId, requestedOperations: [...] }), aad = pairingId)
```

```json
{ "pairingId": "8Kd3fQmR7vT1pLz", "cA": "base64url(32)", "sealedA": { "iv": "...", "ciphertext": "...", "tag": "..." } }
```

**B verifies `cA` here, and this is where a wrong code burns the invitation.** A failure means one of two things — a wrong code, or an active relay — and both are terminal for the invitation:

- `state = burned`; no further `start`, `confirm`, or `poll` is accepted for it
- a local audit record with the claimed identity, the source, and the outcome
- `403` `MESH_PAIR_CONFIRM_FAILED` to the caller

B then unseals `sealedA`; a GCM failure is the same terminal outcome. B **stages** the record: `{ keyIdA, sha256(tokenA), peerNodeId }` is written with `state: staged`, not yet usable.

This is the correction to the earlier draft, which had the *initiator* detect a bad responder confirmation and abort locally — a path on which the responder learns nothing and therefore cannot burn anything, while the UI and the end-to-end suite both demanded that it burn.

### Message 4 — human approval on B

B's UI shows the initiator's display name, fingerprint, the identity public key's fingerprint, the claimed addresses, **and the SAS**, with an explicit "the codes match" confirmation before Approve becomes available.

### Message 5 — B → A: the `pair/finish` response

Approval is asynchronous, so `pair/confirm` answers `202` and A polls:

```json
{ "state": "pending-approval", "pollAfterMs": 1500, "expiresAt": 1758200000000 }
```

`POST /mesh/v1/pair/poll` carries `{ pairingId, cA }`. `cA` is required so the poll is bound to the same handshake rather than being a bare id lookup. Rate-limited.

Approval produces B's side:

```
keyIdB  = 16 random bytes, base64url
tokenB  = 32 random bytes, base64url
sealedB = AES-256-GCM(sealKey, iv, JSON({ protocol, keyId: keyIdB, token: tokenB,
                                          nodeId: B.nodeId, requestedOperations: [...] }), aad = pairingId)
```

`200 { "state": "approved", "cB": "...", "sealedB": { ... } }`

**Idempotent redelivery.** The response is identical on every poll until A acknowledges, for a bounded window (`pairDeliveryWindowMs`, default 120000). The earlier draft delivered it once and called the pairing done, which loses the only copy of `sealedB` on any network hiccup between the two sides.

### Message 6 — A → B: `POST /mesh/v1/pair/ack` — authenticated by `tokenA`

A verifies `cB` first; a mismatch is reported to the human as either a wrong code or an active relay, and A calls `pair/abort`.

```json
{ "pairingId": "8Kd3fQmR7vT1pLz", "accepted": true }
```

A presents `Authorization: Bearer tokenA` with `keyIdA`. B looks the **staged** record up by `keyIdA`, verifies the token against the staged hash, and commits it:

- `staged` → `committed`: the inbound record becomes usable and the invitation becomes terminal
- the response is `{ "state": "committed" }`, returned identically on a repeat
- B keeps the staged record recoverable for `pairDeliveryWindowMs`, so an ack lost in transit is retried rather than stranding a half-pairing
- after the window, an unacked staged record is deleted and the invitation is reported as `MESH_PAIR_INCOMPLETE` to both sides

A commits its own outbound record for B at the moment it successfully verifies `cB` — before sending the ack — so a crash between the two leaves A paired and B staged, which the next `pair/ack` retry repairs. The reverse order would leave A believing it never paired while B holds a usable inbound token.

### Compensating revocation

`POST /mesh/v1/pair/abort` with `{ pairingId }`, authenticated by `tokenA` against the staged record. B deletes the staged or committed record and burns the invitation. A calls it when it cannot verify `cB`, when a human cancels after `sealedB` arrived, or when its own credential write fails. This is the compensating action the earlier draft had no place for.

## State machine

```
        create
          │
          ▼
       ┌──────┐  start (first)     ┌─────────┐  cA verifies   ┌──────────┐
       │ open │───────────────────►│ claimed │───────────────►│ pending  │
       └──────┘                    └─────────┘                └──────────┘
          │                            │                       │  │
   TTL    │                     TTL    │                approve│  │deny / TTL
   expiry │                     expiry │                       ▼  ▼
          ▼                            ▼                 ┌──────────┐ ┌────────┐
      ┌─────────┐                  ┌─────────┐           │ approved │ │ denied │
      │ expired │                  │ expired │           └──────────┘ └────────┘
      └─────────┘                  └─────────┘                │ ack
                                                              ▼
                                                        ┌────────────┐
                                                        │ committed  │
                                                        └────────────┘

  Any state ── cA fails, unseal fails, abort, or attempts exhausted ──► burned
  approved  ── no ack within pairDeliveryWindowMs ──► staged record deleted
```

`expired`, `denied`, `committed`, and `burned` are terminal. A terminal invitation is removed on the next sweep (default 60 s) and its key material is zeroed.

Every terminal outcome is also recorded in the durable audit with the local-only classification, so the operator can tell "wrong code" from "expired" from "relayed" even though the caller cannot.

## Routes and authentication

The authoritative table lives in [the architecture](../02-proposal/02-architecture.md#routes-and-authentication). In summary for this protocol: `pair/start`, `pair/confirm`, and `pair/poll` are unauthenticated by token — the SPAKE2 confirmations are their authentication — and `pair/ack` and `pair/abort` require `tokenA`.

## Bounds

| Field | Default | Owner |
|---|---|---|
| `invitationTtlMs` | 600000 | `dsh-mesh` |
| `pairDeliveryWindowMs` | 120000 | `dsh-mesh` |
| `maxAttemptsPerInvitation` | 5 | `dsh-mesh` |
| `maxOpenInvitations` | 4 | `dsh-mesh` |
| `pairRateLimitPerMinute` | 60 global | `dsh-mesh` |
| `pairPollIntervalMs` | 1500 | `dsh-mesh` |
| `pairingTimeoutMs` | 600000 | `dsh-mesh-cli` (the client's own wait) |
| code alphabet, code length, SAS digits, scrypt parameters, HKDF labels, transcript layout | fixed | protocol constants |

### Per-source limiting is topology-dependent

Under the recommended `tailscale serve` topology the backend sees the local proxy, so **per-source rate limiting and source pinning do not work**. They are available only under a direct Tailscale bind. The security argument for each topology is written out in [the architecture](../02-proposal/02-architecture.md#caller-identity-per-topology); the earlier draft applied source-based controls unconditionally and would have rejected every request or protected nothing, depending on the reading.

## Failure responses

| Condition | Status | Code | Burns the invitation? |
|---|---|---|---|
| Unsupported protocol version | 426 | `MESH_VERSION_UNSUPPORTED` | no |
| Unknown, expired, burned, denied, or already-committed invitation | 404 | `MESH_PAIR_UNKNOWN` | no (already terminal) |
| Rate limited | 429 | `MESH_PAIR_THROTTLED` | on exhaustion only |
| `cA` verification failed | 403 | `MESH_PAIR_CONFIRM_FAILED` | **yes** |
| `sealedA` authentication failed | 403 | `MESH_PAIR_CONFIRM_FAILED` | **yes** |
| Denied by the operator | 403 | `MESH_PAIR_DENIED` | yes |
| Approval window closed | 408 | `MESH_PAIR_APPROVAL_TIMEOUT` | yes |
| Aborted by the initiator | 200 | — | yes |
| Ack after the delivery window | 410 | `MESH_PAIR_INCOMPLETE` | already terminal |
| Body over the pairing cap | 413 | `MESH_BODY_TOO_LARGE` | no |

No response contains the code, any part of a token, or a distinguishable "wrong code" versus "no such invitation".

## Crash and message-loss matrix

Every boundary is a case in [the validation inventory](../04-validation/07-case-inventory.md).

| Crash or loss point | Result | Recovery |
|---|---|---|
| After B creates the invitation | Invitation is gone (memory only) | The human creates a new one |
| After A sends `start`, before B replies | Invitation claimed by a source that never returns | The invitation expires on its TTL; the human re-invites |
| After B replies, before A sends `confirm` | Invitation claimed, unconfirmed | Same |
| A crashes before minting `tokenA` | Nothing written anywhere | Re-invite |
| B crashes after staging, before approval | Staged record and invitation lost | Re-invite; A's `poll` gets `404` and reports a named failure |
| B approves, A crashes before receiving `sealedB` | B holds a committed-capable staged record | A restarts, re-runs `pair`? No — A has no state, so the human re-invites; B's staged record expires and is deleted |
| A receives `sealedB`, crashes before committing its outbound record | A holds nothing; B holds a staged record | Same as above |
| A commits its outbound record, crashes before the ack | A is paired, B is staged | A retries `pair/ack` on its next presence cycle within the delivery window; B commits |
| A commits, ack is lost in transit | Same as above | Same |
| B receives the ack, crashes before committing | Staged record survives in the audit domain | On restart B re-reads staged records and, if the window is open, offers recovery; otherwise deletes and reports `MESH_PAIR_INCOMPLETE` |
| A's credential write fails after `sealedB` | A holds nothing usable | A calls `pair/abort`; B deletes the staged record |

## Versioning

The protocol string is carried in every message. A node advertises `["dsh-mesh/1"]` in `/mesh/v1/hello`. A future version is added to the list, never substituted in place, so a node can pair with a peer that speaks only one of them. Every stored record and every sealed payload carries `version: 1`; an unknown version is refused, never parsed leniently.

## Interoperability vectors

`tests/vectors.ts` must pin, and a spec must assert:

1. **RFC 9382 Appendix B vectors**, run against this implementation with only the group swapped to edwards25519, checking `pA`, `pB`, `K`, `TT`, `Ke`, `Ka`, `KcA`, `KcB`, `cA`, `cB`. The RFC publishes no edwards25519 vectors, so this is a structural conformance check, and the edwards25519 M/N constants from RFC 9382 §6 are themselves asserted against the published values.
2. `normalizeCode` over accepted and rejected spellings.
3. A fixed `transcript` with an expected SHA-256.
4. Fixed code, pairingId, and ephemeral scalars producing expected `Ke`, `cA`, `cB`, SAS, and `sealKey`.
5. A fixed `sealKey`, IV, and plaintext producing an exact AES-256-GCM ciphertext and tag.
6. **Negative:** two spliced handshakes fail both confirmations; a wrong code fails `cA`; a tampered `pB` fails `cB`; a modified transcript fails the transcript-bound checks.
7. **Interop:** a second, independently written implementation of the same vectors — at minimum a test-only script that uses the PAKE's primitives directly rather than the production module — so a refactor cannot silently redefine the protocol.
