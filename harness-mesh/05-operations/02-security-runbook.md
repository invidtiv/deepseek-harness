---
description: "Authorization, key handling, revocation semantics, rotation by re-pairing, the durable audit, and incident response for a paired mesh node."
kind: "operations"
---

# Security runbook

## The one authorization input

| Input | Role |
|---|---|
| The bearer token minted inside the SPAKE2 pairing handshake, presented by the node that minted it | **The only authorization input.** Verified per request against a stored SHA-256 hash under `mesh/grant/<keyId>` on the serving node |

Everything else an operator might mistake for identity is an annotation:

| Signal | Role | Limits |
|---|---|---|
| `Tailscale-User-Login`, `Tailscale-User-Name`, `Tailscale-User-Profile-Pic` | Display and audit annotation | Added by `tailscale serve` for HTTP/HTTPS only; RFC 2047 Q-encoded when non-ASCII; inbound copies are stripped on the Serve path; **absent entirely** for Funnel traffic, for tagged devices, and when WhoIs fails |
| `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto` | Display and audit annotation | Written by Serve (source-only: they are not in the Serve documentation), and writable by any local process |
| The observed peer address | Rate limiting and source pinning, and only under topology T3 | Under T1 and T2 the observed peer is the local proxy |
| `tailscale whois` output | Optional corroboration under T3 | Needs an address you already hold, plus root or operator permission |

The rule, stated once: **a caller is authorized by a token it proved it held during pairing, never by where it appears to come from or by a header that a proxy or a local process can write.** A process that connects directly to the backend bypasses Serve and can forge every advisory header; "listen on localhost" limits tampering to other services on the Serve device, which is blast-radius reduction and not authentication. [The Tailscale runbook](01-tailscale-runbook.md) documents the headers and the three topologies.

## What lives where

| Secret | Location | Lifetime | Compromise impact |
|---|---|---|---|
| Node identity private key | credential record `mesh/identity` in `$DSH_HOME/.credentials.yaml` | until the home is deleted | An attacker can sign this node's pairing and presence challenges |
| Outbound peer token | credential record `mesh/peer/<nodeId>` | until unpaired | An attacker can call the peer within that peer's grant for this node |
| Inbound token hash | credential record `mesh/grant/<keyId>` | until unpaired | A file disclosure yields nothing usable against this node |
| Audit correlation key | credential record `mesh/audit` | until deleted | An attacker who also holds the audit log can confirm a guessed argument |
| Loopback self-session cookie | process memory only | process lifetime | None beyond this machine: it is already the local full API |
| Pairing code | a human's screen, then memory | the invitation TTL, 10 minutes by default | An attacker could pair as this node only by also reaching the endpoint inside the TTL, winning the source claim, and passing approval without comparing the SAS |

The first four live in the same file as the model API keys and the browser-session secret. That file is the machine's single credential store: `chmod 600`, excluded from backups that leave the machine unencrypted, never copied between machines.

## Routine operations

### Pair a node

```bash
# On the responder
dsh mesh invite
# prints, on that terminal only: a code, its expiry, and the command the other machine runs:
#   dsh mesh pair --node <endpoint> --pairing-id <id>

# On the initiator
dsh mesh pair --node <that-node>.tail652dda.ts.net:<publishedPort> --pairing-id <id>
# It asks for the code; the prompt is masked.
# -> SAS 123-456: compare it out loud with the other machine, then confirm.
```

Rules that are part of the design, not advice:

- **There is no `--code` flag.** A command line containing one is from an earlier draft and must not be used.
- On a terminal the code is read from a masked prompt. When stdin is not a terminal it is read from stdin, which is what the cross-machine suite pipes.
- **Never put the code in an environment variable, a file, a URL, shell history, or a message a network carries.** Read it aloud or type it.
- The command the responder prints carries the endpoint and the **public** `pairingId` only. The `pairingId` is not a secret.
- No model tool accepts the code, and none ever will: a tool call is durable model-visible history.
- The code never appears in a log, an audit record, a URL, an error message, or a metrics label.

### Read what a peer may do

```bash
dsh mesh nodes --json
dsh mesh grants --node <nodeId> --json
```

### Narrow a grant

```bash
dsh mesh grants --node <nodeId> set \
  --allow session.list,session.read,session.transcript,session.follow \
  --cwd-roots '' \
  --expires-in 7d
```

An empty `--cwd-roots` denies every remote `cwd`, which is correct for a read-only peer. The per-flag spelling of `grants set` is **unverified**: the package plan fixes only the command set (`invite`, `pair`, `approve`, `deny`, `nodes`, `grants`, `unpair`, `audit`, each with `--json`), so `dsh mesh grants --help` is authoritative once the CLI ships.

### Grants are not confinement

- `cwdRoots` is a lexical allowlist on the directory a request may **name**. Paths are resolved before comparison, and it governs only the starting directory.
- It is **not** confinement. An agent started inside an allowed root reaches elsewhere with ordinary tools.
- Real confinement is a permission preset or an execution world named in the grant (`confinement: { kind: 'permission-preset' | 'execution-world', id }`). The plugin refuses to load a composition that grants a write operation without one.
- **A peer granted a write operation under a preset that does not actually confine has remote code execution on this machine.** The shipped default grants no write operation at all.

### Revoke

```bash
# On this node: delete this node's grant record and the peer's inbound token hash.
dsh mesh unpair --node <nodeId>
```

The package plan declares `unpair` without spelling out how it names the peer, so treat `dsh mesh unpair --help` as authoritative for the argument once the CLI ships.

Exactly what revoking does:

- It stops **this node** accepting that peer immediately: the local grant record and the peer's inbound token hash are deleted, and the next request from the peer is refused. Revocation is evaluated per request from the store, never cached, so no restart is involved.
- It **cannot** make the peer drop the token it holds. The mesh also performs an authenticated, idempotent remote revoke as cleanup, and that step is **best effort**: it fails when the peer is offline, unreachable, or already unaware of the pairing. The command reports which of those happened; do not describe the peer as revoked on the strength of the local half alone.
- Unpair on **both** sides when a machine is retired or handed to someone else. Do not assume the far side is clean because this side is.
- The local half is what `E-OPS-02` asserts; `E-OPS-03` asserts that a fresh invitation pairs again and mints a new key id.

### Rotation

**There is no rotation operation.** No command rotates a mesh credential, and an instruction that names one is from an earlier draft. Rotation is **unpair plus re-pair**, which the plan already tests: `E-OPS-02` unpairs, `E-OPS-03` pairs again with a fresh invitation and asserts the new key id differs from the old one.

```bash
dsh mesh unpair --node <nodeId>     # on both nodes
dsh mesh invite                     # on the node that will respond
dsh mesh pair --node <endpoint> --pairing-id <id>
```

The new pairing mints a new `keyId`; the old record is gone because unpair deleted it. A new SAS is compared out of band, exactly as at first pairing. Re-pairing is also the answer to a suspected token leak and to a planned key change, so there is no separate ceremony to write down.

### Read the durable audit

```bash
dsh mesh audit --limit 50 --json
dsh mesh audit --node <nodeId> --json
```

What the audit is, and is not:

- It is **durable**: a declared storage domain (`mesh-audit`, version 1) routed to whatever backend the deployment configures. It survives a restart; it is not a volatile in-memory ring.
- It is **bounded and prunable** by record count and age (`maxAuditRecords`, `maxAuditAgeMs`), pruned on write-batch boundaries and on activation. A full audit drops the oldest records and counts the drops.
- Argument correlation is **HMAC-keyed**: `HMAC-SHA256(auditCorrelationKey, canonicalJson(args))` under a local key held in the `mesh/audit` credential record. There are no plain hashes of arguments, and the key never leaves the node.
- Records carry no content: no prompt text, no paths, no tokens, no cookies, and no pairing code.
- Every terminal pairing outcome is classified locally — "wrong code" is distinguishable from "expired" from "relayed" — even though the caller cannot distinguish them. Unauthenticated callers get one collapsed code; see [the troubleshooting runbook](03-troubleshooting.md).
- If the domain cannot be opened or a write fails, the node raises `MESH_AUDIT_UNAVAILABLE`, counts the dropped records, and follows `auditFailurePolicy`. The shipped value is `refuse-writes`: an unlogged remote turn is worse than a refused one.

## Incident response

### A pairing code leaked

1. The code is useless without reaching the endpoint inside the TTL, winning the source claim, and passing approval. If the invitation is still open, deny it or let it expire.
2. If a pairing completed that the operator did not authorize, unpair on both sides.
3. Read the durable audit on the responder for the pairing and for any request that followed it; the pairing rows carry the local classification.
4. If anything ran, treat the affected machine as having had unattended execution and follow that machine's own incident process.

### A peer token leaked

1. On this node: `dsh mesh unpair --node <nodeId>` deletes the grant record and the inbound token hash, and this node stops accepting that peer on the next request.
2. The peer still holds **its own** outbound token until it revokes it. The mesh's remote cleanup is best effort; if the peer is unreachable, the token survives on that machine and the only complete answer is to reach it and unpair there too. Say that plainly rather than implying the leak is closed.
3. Review the audit for the window between the leak and the revocation.
4. Re-pair with a fresh invitation if the relationship should continue; the new key id differs from the old.

### The credentials file leaked

1. Assume every secret in it is compromised: the model API keys, the browser-session secret, and every mesh token, identity, and audit key.
2. Rotate the model keys with their providers.
3. Delete the browser-session record so a new signing secret is created on the next start; this invalidates every browser cookie.
4. On every peer, unpair this node and re-pair it. A re-pair with the **same** identity file keeps the same fingerprint; if the file itself leaked, delete `mesh/identity` first so a new fingerprint is minted, and expect every peer to report `MESH_IDENTITY_CONFLICT` and require an explicit re-pair.
5. The audit key leaked too: an attacker who also holds the audit log can confirm guessed arguments. That exposure is not repairable after the fact; record it.

### A machine was cloned

Both machines now hold the same identity, so both can sign as the same node. A peer that sees a different fingerprint for a known `nodeId`, or the same fingerprint for a different `nodeId`, refuses the request with `MESH_IDENTITY_CONFLICT`. A clone that never runs concurrently with the original is undetectable, so the mitigation is procedural: delete the identity when a `$DSH_HOME` is copied.

```bash
# On the clone: remove the copied identity so a new one is minted.
# The package plan declares no identity command, so today this means deleting the
# mesh/identity credential record from the clone's $DSH_HOME. Unverified until the CLI ships.
```

Then unpair the old identity on every peer and pair the new one.

### Funnel exposure was detected

```bash
tailscale funnel status
tailscale funnel --https=<port> off
tailscale funnel --tcp=<port> off
tailscale serve status
```

Funnel traffic carries **no identity headers at all**, so a Funnel-exposed port had no advisory identity either — the bearer token was the only control. If any request could have been served, treat the window as a token-disclosure event: unpair and re-pair.

## Periodic hygiene

| Cadence | Action |
|---|---|
| Monthly | `dsh mesh nodes` — remove peers that are decommissioned or no longer needed |
| Monthly | `dsh mesh grants` — confirm every write operation still needs to be allowed, that every write grant names a confining preset, and that it carries an `expiresAt` |
| Monthly | Read the audit for denied requests, which often reveal a stale grant |
| On every harness upgrade | Re-run the doctor; a version bump can change the protocol advertisement |
| On any machine handover | Unpair on both sides before wiping |
| After a tailnet ACL or `serve` change | Re-run the doctor's Funnel row |

## Hardening options

| Option | Effect | Cost |
|---|---|---|
| T1 (unix socket) rather than T2 | Removes the loopback TCP door; the socket's permissions are the only local door | The listener must create and own a socket |
| T3 (direct bind) rather than T1 or T2 | The peer address is authentic, so per-source rate limiting, source pinning, and optional `whois` become possible | No application-layer TLS, and the listener must bind a Tailscale address |
| A confining preset on every write grant | Turns a write grant into bounded execution instead of remote code execution | Requires the sandbox and execution-world machinery to be configured |
| `approval: 'always'` on every write grant | No remote turn runs without a local human | Every write blocks on a person |
| `expiresAt` on every grant | A forgotten pairing stops working by itself | Re-pairing on a schedule |
| `auditFailurePolicy: 'refuse-writes'` (shipped) | An unlogged remote turn is refused | Remote writes stop while storage is unavailable |
| SPAKE2 pairing | Removes the offline-guessing path | One crypto dependency |

Earlier drafts listed `discovery.enabled` and `requireTailscaleSource`. Discovery was removed from v1 (nodes are configured explicitly), and source-based controls exist only under T3, where the observed address is real. There is no separate identity-source setting: the bind target in `listen` determines the topology.

## What this design does not protect against

Stated plainly so no operator over-trusts it:

- An attacker with root or operator permission on either node, who can read process memory or talk to the LocalAPI.
- A compromised harness build or a malicious plugin already mounted in the composition.
- An attacker with admin access to the tailnet, who can retag or re-key devices.
- A local process that connects directly to the listener under T1 or T2 and forges advisory headers. That is documented, and the token still applies.
- Replay of a request by a party that already holds a valid token: bearer tokens do not prevent it, and `Idempotency-Key` only makes it harmless for writes.
- A human who approves a pairing without comparing the SAS.
- A clone that never runs concurrently with the original.
- Coercion.