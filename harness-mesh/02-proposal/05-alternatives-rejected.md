---
description: "Every cheaper or more obvious alternative, including the ones a design review proposed as replacements, and the concrete reason each is rejected."
kind: "proposal"
---

# Alternatives considered, and why each is rejected

Each alternative would be less work than the plan. Each fails for a reason stated in the harness's own source, in the note that decided the existing peer control plane, or in Tailscale's documented behavior.

## 1. Bind the GUI to the tailnet and reuse `peer-remote` with a cookie

**Rejected because:**

- `packages/bundle/web-app/src/startup.ts` refuses `--host 0.0.0.0` with the message that it would expose remote code execution to the network. The mesh would be reintroducing exactly that.
- `packages/host/webserver`'s schema accepts only `'127.0.0.1'` and `'0.0.0.0'`, so "bind only the tailnet" is not expressible without a core schema change.
- Even on that bind, `/plugins` and `/plugins/events` have **no authentication check**, and the non-index static assets are public.
- The peer control-plane note already rejected this option by name.
- The cookie is still authority-bound and still harvested by hand, so it does not even solve the pairing requirement.

## 2. `tailscale serve` the existing GUI and keep the cookie

**Kept only as future compatibility work, not in the MVP.** It still requires a human to extract a cookie from a browser session on that exact authority; a leaked cookie is the peer's complete tool-capable API; the GUI's unauthenticated routes ride along on the published port; and there is no grants model, no audit, no live stream, and no cancellation. It also contradicts G1, which is why the earlier draft's `legacyPeers` configuration was removed from the MVP and tracked separately.

## 3. Drive the peer over SSH stdio, as a remote subagent provider

**Rejected because** the peer control-plane note already evaluated it: every call becomes a new remote process, each peer needs a server-side profile and a forced command, and **session listing and transcript reads have no equivalent**. It also puts an SSH key on every node and makes the harness reachable from any SSH login there. It remains a reasonable *additional* transport later, and the `ctx.peers` registry is designed to accept one; it is not the pairing story.

## 4. Share `$DSH_HOME/sessions` over a network filesystem

**Rejected, with evidence from the storage layer:**

- The single-writer guarantee is a **kernel lease**: POSIX `flock(2)`, and on Windows a **named kernel semaphore whose name is per login session**. `flock` is advisory and unreliable on NFSv3, so a shared mount silently loses the exclusion the store depends on.
- `checkRootEncoding()` rejects a root mixing the `zstd` and `none` suffixes, so both nodes must agree on compression for the entire root.
- `findLog(id)` **throws** on a duplicate session id across project directories, and `assertStoredIdentity` recomputes the expected path from the session's recorded `cwd`, so two machines with different working-directory spellings collide.
- The derived `session-query-sqlite` index is documented as single-owner per path: external writers and multi-process sharing are unsupported.
- Both sides' lives then depend on a network filesystem being up; a partition becomes silent corruption rather than a clean error.

Two harnesses under the *same* `$DSH_HOME` on the *same* machine already share a session list, because both mount `session-persistence-jsonl` at the same root. That is a local property and the plan does not build on it.

## 5. Wrap the SDK in a TCP transport

**Rejected because** the method set is closed and too small: `initialize`, `session/prompt`, and `shutdown` inbound, and four notifications outbound. There is **no list, no resume, no history read, and no cancel**. Session listing and transcript reads — the actual "share the sessions" requirement — have no SDK method at all. Adding them means designing a new protocol inside the SDK, which is the same work with a worse home.

The mesh protocol borrows the SDK's shape — a small method set, a real handshake, server-pushed events — and reuses the Remote API's methods.

## 6. Use the webhook plugin as the command channel

**Rejected because** delivery `kind` is hard-coded `'github'`, the response is `202` with no result, and there is no queue, dedup, retry, or cancel. Reusing it means writing a new adapter package anyway, and the harness would then have two differently-authenticated ways to start sessions on one node.

## 7. Extend `experimental/agent-team` across machines

**Rejected because** the team model is one process by construction: `TeamId` is the Lead's session id, the roster and mailbox are replay projections of one session log, and its README states the mailbox is not cross-process exactly-once.

## 8. `ssh -L` a tunnel instead of `tailscale serve`

**Rejected as the default** because it adds an SSH dependency and a second credential system to a solution whose point is that the tailnet already provides transport. It is a **fallback** for a node where HTTPS certificates cannot be enabled; in that case the mesh binds its own Tailscale address directly (topology T3) and needs no tunnel at all.

## 9. mTLS with `tailscale cert` instead of token pairing

**Rejected because** `tailscale cert` issues a certificate for **the node's own name**, not a CA that signs peer identities. Mutually verifying two `*.ts.net` leaf certificates proves only that each side holds a Tailscale-issued certificate for a name — which an attacker controlling any tailnet device also holds. It would still need an application-level allowlist of accepted peer fingerprints, which is what pairing produces. Not less work, not stronger.

## 10. Trust the tailnet and skip application authentication

**Partly right, and rejected as the only control.** Tailscale does provide cryptographic device identity, and the mesh uses `tailscale whois` as **corroborating evidence** under the one topology where it applies. It fails as the sole control because:

- A tailnet can contain **tagged devices not under the operator's control**, and the reference tailnet does.
- `whois` maps an address to a node, and under a Serve topology the backend has no such address; it also needs root or operator permission.
- Tailscale ACLs express which ports and users may connect, not which operations a peer may perform on which sessions.
- It makes the ACL file the only place a user can express "node A may read but not drive my sessions", which is not what ACLs are for.

## 11. A hand-built X25519 exchange with the code mixed into the KDF

**Rejected, and this is the correction the review forced.** The construction was: plain ephemeral X25519, then derive the confirmation tags, the SAS, and the seal key from `HKDF(Z || code)`. It is simple, it uses nothing but `node:crypto`, and it defeats a relay that does not know the code.

It is still wrong, for one reason: **a recorded transcript is an offline verifier for the 40-bit code.** An attacker who captures the exchange can enumerate all 2^40 codes and test each against the transcript without touching either machine, and no amount of short-authentication-string comparison detects that, because the SAS detects an *active* relay, not an *offline* crack.

The plan now requires **SPAKE2 (RFC 9382) over the edwards25519 ciphersuite**, where a captured transcript yields no checkable value without guessing an ephemeral secret. The edwards25519 M and N constants are published in RFC 9382 §6, so no hash-to-curve implementation is needed, and RFC 9382 Appendix B supplies vectors to check the implementation against.

## 12. OPAQUE instead of SPAKE2

**Rejected as the wrong protocol family.** `@serenity-kit/opaque` is the only npm PAKE with an independent third-party whitebox audit, and it is the natural instinct to prefer an audited binary over an implementation. But OPAQUE is an **augmented** (asymmetric) PAKE whose entire purpose is protecting a **stored registration record**. This flow is symmetric, ephemeral, single-use, and stores nothing. Adopting OPAQUE would introduce a registration ceremony and a stored record whose combination with the server setup **is an offline verifier for a 40-bit code** — the exact property the review rejected in the hand-built construction. RFC 9382 §7 says it directly: applications needing augmentation should use OPAQUE, and SPAKE2 does not support augmentation.

**Named as the fallback.** If a third-party-audited PAKE binary becomes a hard requirement, `@serenity-kit/opaque` is the candidate, and the price is stated above rather than hidden.

## 13. PROXY protocol to recover the true client address under Serve

**Rejected because it is not available.** `tailscale serve` supports the PROXY protocol for **TCP forwarding only**; it is explicitly rejected for HTTP and HTTPS, and also for unix socket targets. The header-based HTTPS reverse proxy that the mesh uses cannot carry it. The only configuration in which the peer address is authentic is a direct bind on the node's own Tailscale address, which is offered as topology T3.

## 14. Serve to a loopback TCP port (the earlier default)

**Not rejected, but demoted.** Any local process can connect straight to `127.0.0.1:<port>`, bypass Serve, and forge the advisory identity headers. Authorization does not depend on those headers, so this is a display-and-audit integrity weakness rather than a bypass — but a unix socket target removes the path entirely, because there is no TCP port to connect to. The unix socket is now the default (T1), loopback TCP is T2, and the direct bind is T3.

## Summary

| Alternative | Cheaper? | Solves pairing? | Solves live sharing? | Solves grants? | Verdict |
|---|---|---|---|---|---|
| 1. `0.0.0.0` GUI + cookie | yes | no | no | no | Rejected — reintroduces the rejected exposure |
| 2. Serve the GUI + cookie | yes | no | no | no | Future compatibility work only |
| 3. SSH stdio | medium | no | no | no | Later optional transport |
| 4. Shared session root | medium | n/a | partly | no | Rejected — loses the write lease |
| 5. SDK over TCP | medium | no | no | no | Rejected — no list, resume, or cancel |
| 6. Webhook | low | no | no | no | Rejected — one-way and GitHub-shaped |
| 7. Cross-machine agent-team | high | no | n/a | no | Rejected — one process by construction |
| 8. SSH tunnel | low | no | no | no | Fallback transport only |
| 9. mTLS | medium | no | no | no | Rejected — proves nothing about peers |
| 10. Tailnet-only trust | low | no | no | no | Corroboration only |
| 11. Hand-built X25519 + HKDF | low | **insecurely** | n/a | n/a | Rejected — offline verifier for the code |
| 12. OPAQUE | medium | yes | n/a | n/a | Named fallback — wrong protocol family here |
| 13. PROXY protocol | low | n/a | n/a | n/a | Unavailable for HTTP and HTTPS |
| 14. Serve to loopback TCP | low | yes | yes | yes | Kept as T2; unix socket is the default |
| **The mesh plan** | high | **yes** | **yes** | **yes** | — |
