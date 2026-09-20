---
description: "Assets, adversaries, mitigations, and residual risk for the mesh pairing and operation planes, corrected after design review."
kind: "proposal"
---

# Threat model

## Assets, in order of value

| # | Asset | Where it lives | If it leaks |
|---|---|---|---|
| A1 | A node's Remote API capability | Any valid credential accepted by that node's `/api` | Unattended tool execution on that machine |
| A2 | An outbound mesh token | `ctx.credentials` record `mesh/peer/<nodeId>` | An attacker impersonates this node to that peer, within the grant |
| A3 | The node identity private key | `ctx.credentials` record `mesh/identity` | An attacker can answer a signed challenge as this node |
| A4 | Session contents | `$DSH_HOME/sessions`, served through the owner's API | Source code, prompts, and model output from that machine |
| A5 | The pairing code | A human's screen and memory, for at most the invitation TTL | Pairing as that peer, if the attacker also wins the human approval |
| A6 | The loopback self-session cookie | Process memory only | Local-equivalent access; the node already trusts local callers |
| A7 | The audit correlation key | `ctx.credentials` record `mesh/audit` | An attacker who also has the audit log can confirm guessed arguments |

## Adversaries

| # | Adversary | Assumed capability |
|---|---|---|
| T1 | Passive network observer | Reads all tailnet traffic. WireGuard is assumed to defeat this, but the design does not rely on it alone |
| T2 | Active relay | Intercepts, modifies, drops, and reorders mesh messages between two honest nodes |
| T3 | Unpaired tailnet neighbour | Any device on the tailnet, including tagged devices owned by someone else |
| T4 | Guessing attacker | Reaches the pairing endpoint and tries codes |
| T5 | Credential thief | Read access to a node's `.credentials.yaml`, or to its process memory |
| T6 | Malicious peer | A legitimately paired node exceeding the intent of its grant |
| T7 | Local unprivileged user | Can reach the loopback listener, and can forge advisory proxy headers |
| T8 | Clone operator | Has a byte-identical copy of a node's `$DSH_HOME` |
| T9 | Operator error | Misconfiguration that widens exposure without an attacker |

## Mitigations

### T2 — active relay

**Primary control: a reviewed PAKE.** The handshake is SPAKE2 over a prime-order group, with the short code as the password. A relay that guesses the code at the wire can attempt exactly one online guess per handshake and is detected by the confirmations; a relay that captures a transcript gains **no offline verifier**, which is the property a hand-built Diffie-Hellman-plus-HMAC construction does not provide and which an earlier draft of this plan wrongly deferred to an optional phase.

This corrects a real defect. The previous design mixed the code into an HKDF after a plain X25519 exchange, which leaves a transcript that can be attacked offline against all 2^40 codes. The review rejected it and the PAKE is now mandatory in v1.

**Secondary control: the short authentication string.** Both humans compare a six-digit SAS derived from the agreed key. Two relayed legs produce different keys, so the strings differ. The SAS is not optional and there is no non-interactive bypass in interactive mode.

**Tertiary control: transcript binding.** Every field is length-prefixed and the whole transcript is absorbed into the key schedule, so fields cannot be spliced between two concurrent handshakes.

**Residual risk.** A human who approves without comparing the SAS is unprotected against a relay. The UI therefore shows the SAS on both sides and requires an explicit confirmation, and the runbook says why.

### T3 — unpaired tailnet neighbour

The route and authentication table in [the architecture](../02-proposal/02-architecture.md#routes-and-authentication) is normative: exactly one route is anonymous, and it returns a fixed, minimal document. Every other route requires a bearer token verified against a stored hash.

**Honest limitation.** The anonymous route discloses that a DSH node is running and what it calls itself. Operators who consider that unacceptable set `discovery.enabled: false`, at the cost of manual address entry.

### T4 — guessing attacker

The code is 40 bits and single-use, an invitation accepts at most five attempts and burns on the first failed confirmation, and the endpoints are rate-limited globally and per invitation.

One control from the earlier draft does **not** survive: **per-source rate limiting and source pinning are unavailable under the recommended `tailscale serve` topology**, because the backend sees the local proxy. The corrected rate-limit design is stated in [the architecture](../02-proposal/02-architecture.md#caller-identity-per-topology) and the security argument is written out there: under T1 the controls are global and per-invitation limits plus the human approval step; under T2 the per-source limits and source pinning apply as originally designed. This is a real reduction in defence for T1 and it is stated rather than assumed away.

### T5 — credential thief

- Inbound tokens are stored **only as SHA-256 hashes** (`mesh/grant/<keyId>`), so a stolen grants store yields nothing usable against the serving node. The token carries its `keyId`, so a hash lookup is one indexed read.
- Outbound tokens must be stored in cleartext to be usable; they live in `ctx.credentials` beside the model API keys, with the same file permissions.
- Every grant carries `expiresAt` and `lastUsedAt`.
- Revocation is evaluated per request from the store, never cached.

### T6 — malicious peer

The grant is the control, and the plan is explicit that **the grant is not confinement**:

- **Reads** default on. **Writes** default off.
- `cwdRoots` is a lexical allowlist on the directory a request may *name*, resolved before comparison so symlinks and junctions cannot escape it. It is **not** a confinement mechanism: an agent started inside an allowed directory can reach elsewhere with ordinary tools.
- Every **session** operation is authorized against the session's own recorded metadata — its `cwd` and its owner — not against fields supplied by the request, because a `session.prompt` against an existing session names no `cwd` at all.
- A remote turn must run under a **permission preset or execution world that actually confines** filesystem and process access. The grant names that preset. If the node's composition provides no such preset, the write operations that would run a turn are unavailable and the plugin says so at load.
- Budgets: `maxConcurrentTurns`, `maxTurnsPerHour`, `maxPromptBytes`, `maxStreamSeconds`.
- `approval: 'always'` puts a local human in front of every remote turn.

**Residual risk, stated in the words the runbook uses:** a peer granted a write operation with a preset that is not confined has remote code execution on that machine. The shipped default grants no write operation.

### T7 — local unprivileged user, and forged proxy headers

Under the recommended `tailscale serve` topology the mesh listener binds loopback, so any local process can connect to it. Two things follow:

1. **The listener still requires a bearer token.** Reaching it locally grants nothing.
2. **Any identity header a proxy adds is advisory.** A local process can forge it. The design therefore never authorizes on a proxy header: the headers are used for human-readable display and for audit annotation only, and the audit record marks them as claimed rather than verified. This is a deliberate, documented weakness of the T1 topology, not an oversight.

The self-session cookie is the sharper edge, because it is a full local `/api` credential held in memory. It is never persisted, never logged, never returned to a peer, and dropped on unload; re-minting happens at most once per request.

### T8 — clone operator

A byte-identical copy of `$DSH_HOME` contains the node id, the identity key, and every outbound token, so the clone is indistinguishable from the original by possession alone.

The identity key is now **used**, which is what makes detection possible:

- Pairing exchanges and verifies each side's long-term signature over the transcript, so a peer holds a verified public key for the node it paired with.
- Presence and control requests carry a signed challenge response. A clone can produce a valid signature — it holds the key — so possession alone still does not distinguish the two.
- What *is* detectable is **divergence**: two live nodes presenting the same `nodeId` with different ephemeral challenge state, or the same fingerprint from two different transport identities. The mesh raises `MESH_IDENTITY_CONFLICT` and refuses the request, and the operator resolves it by minting a new identity on the clone.

**Residual risk.** A clone that never runs concurrently with the original is undetectable. The runbook states this, and the mitigation is procedural: delete `mesh/identity` when a `$DSH_HOME` is copied.

### T9 — operator error

- A non-loopback bind outside the Tailscale ranges fails the plugin load.
- The plugin reads `tailscale serve status` at startup and warns prominently when the mesh port is **Funnel**-exposed. The reference machine runs a Funnel listener, so this is a live risk.
- A port already bound by a non-mesh process is reported by name.
- Enabling a write operation without `expiresAt`, or without a confining preset, produces a startup warning.

## Failure oracles

The earlier draft specified both `426 MESH_VERSION_UNSUPPORTED` and "the same 404 as an unknown invitation" for a version mismatch, and claimed distinct "unpaired" versus "revoked" codes for a caller that holds no valid token. Both are impossible as written. The corrected rule:

| Caller state | What the caller learns | Where the distinction lives |
|---|---|---|
| No token, or a token that does not verify | One collapsed `401` with one code | The local audit record distinguishes missing, unknown, revoked, expired, and malformed by inspecting the presented token's `keyId` |
| A verifying token whose grant forbids the operation | `403` with the operation named | No disclosure beyond the caller's own grant |
| A protocol version the peer does not speak | `426`, which is not a secret | Reported normally |

A token carries `keyId` so the *serving* node can classify the failure locally without telling the caller which case it was.

## Explicitly out of scope

- An attacker with root on either machine.
- A compromised harness build or a malicious plugin already mounted.
- Tailscale itself compromised, or an attacker with tailnet admin who can retag or re-key devices.
- Coercion of the human who holds the code.
- Local side channels: memory scraping, core dumps, a keylogger on the initiator's terminal.
- A clone that never runs concurrently with the original; see T8.

## Security invariants the implementation must hold

1. The pairing code is never accepted from a command-line argument, never accepted from a model tool call, and never written to a log, an audit record, a URL, an error message, or a metrics label.
2. A token is never echoed back to any caller after the pairing that minted it.
3. Authentication is checked before authorization, and authorization before any Remote call is issued.
4. All secret comparisons use `timingSafeEqual` on equal-length buffers.
5. Revocation is evaluated per request, never cached across requests.
6. The listener serves only the operation set; a grant cannot widen it.
7. A proxy-supplied identity is never an authorization input.
8. `cwdRoots` is never described, in code or in documentation, as confinement.
