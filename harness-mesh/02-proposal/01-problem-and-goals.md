---
description: "Requirements, non-goals, and the acceptance bar for linking two DSH instances across machines, corrected after design review."
kind: "proposal"
---

# Problem, goals, and non-goals

## The problem

Two DeepSeek Harness instances run on different machines — Windows, Linux, macOS — joined by a Tailscale tailnet. The user wants them to:

1. **interconnect** without hand-copying cookies, ports, or URLs;
2. **know each other** — each side knows which nodes exist, which are reachable, and what they are;
3. **share sessions** — a session owned by one node can be listed, read, and followed live from the other;
4. **command each other** — a human in one GUI, or a model in one session, can send work to the other node and see the result.

Connection must be established with a **safe pairing code** plus **Tailscale addresses and ports**.

## Why this is not already possible

The harness has a peer seam (`packages/peer/`) and it works, but its only credential is the peer's **browser-session cookie**: bound to one exact authority, minted only through `GET /?token=<per-process launch token>`, and never persisted. Pairing today means reading a token off the peer's console, opening its URL in a browser, extracting the cookie, and pasting it into an environment variable. It is neither safe nor automatable.

## Goals

Each goal states its measurable check and the case that produces it. G-numbers are stable; a goal that changed after review says so.

| # | Goal | Measurable statement |
|---|---|---|
| G1 | Pair two nodes without a browser and without a pre-shared secret | On the responder, one command creates an invitation and prints a complete, runnable command line. On the initiator, that command line alone completes the pairing after the responder approves. Neither side ships a key in `cordis.yml`; the only shared input is a short human-transferred code |
| G2 | Keep the code out of every durable or inspectable channel | The code never appears in a model tool call or result, in process arguments, in shell history, in a log, in an audit record, or on the wire |
| G3 | Be safe against an active network attacker | The handshake is a reviewed PAKE. A relay that does not know the code cannot complete it, and both humans see a short authentication string that differs under attack |
| G4 | Know the peers | Every **configured** node is listed with its identity, address, published endpoint, paired state, and last successful contact time. Automatic discovery is explicitly out of scope for v1 |
| G5 | Share sessions, live | A paired node can list sessions, read a page, read a transcript, and follow a running session such that intermediate events arrive while the turn is still running, a dropped stream resumes from a cursor without gap or duplication, and a prompt can continue an existing remote session |
| G6 | Command across nodes | A model tool and a GUI control can each send a task to a peer and receive its terminal result, and a nested command is refused by loop control rather than recursing |
| G7 | Fail loud and consistently | Every denial reports a code drawn from one table. Unauthenticated callers cannot distinguish "unpaired" from "revoked" from "expired"; an authenticated local audit record can |
| G8 | Be inspectable after the fact | Every admitted and denied cross-node request is written to a **durable, bounded, rotating** local audit record that survives a restart, with keyed correlation hashes rather than plain hashes |
| G9 | Be revocable with honest semantics | Revoking on one node stops that node accepting the peer immediately. Remote cleanup is best effort through an authenticated, idempotent revoke operation, and the acceptance text says so |
| G10 | Add no new exposure | The GUI listener's posture is unchanged on every node, and no route that is unauthenticated today becomes reachable from the tailnet |

### G1, corrected

The earlier draft printed `dsh mesh pair --node <addr> --code <code>`, which has three defects the review caught and this version fixes:

- **It cannot be sent.** The first message needs the public `pairingId`, which the command did not carry. The invitation now prints a command containing the endpoint *and* the pairing id.
- **It puts the code in process arguments.** `--code` lands in shell history, in `ps` output, and in any process-inspection tool. The command now reads the code from a masked prompt on the terminal; there is no flag that accepts it.
- **`dsh mesh ...` is not a subcommand.** The launcher reads `dsh <name>` as "boot the profile named `name`". The supported shape is a one-shot profile command; see [the package plan](../03-implementation/01-package-plan.md#the-command-surface).

### G2, corrected

The review found that a model-facing `mesh_pair(node, code)` tool cannot exist: a tool call is durable model-visible history, so the code would be logged by definition, contradicting the plan's own never-log invariant. **Model-initiated pairing is removed entirely.** A model may observe pairing state and may ask a human to pair; it can never hold the code. What a model may receive is a non-secret authorization identifier — the `pairingId` — which is public by construction.

### G4, corrected

The earlier draft required unpaired nodes to appear automatically while listing discovery as optional. Discovery in v1 is **removed**: nodes are configured explicitly by seed address, and the node list shows configured nodes with reachability. A future discovery mechanism must first define a rendezvous and an advertisement format; it is tracked separately.

### G8, corrected

The earlier draft claimed "every request is auditable" while specifying a volatile in-memory ring, which loses everything on restart, and a plain `SHA-256` of the arguments, which lets anyone confirm a guessed prompt or path. Both are fixed: a durable bounded rotating owner, and a **keyed** correlation hash (HMAC under a locally held key) that supports correlation without dictionary confirmation.

### G9, corrected

The earlier draft said "either side can unpair; revocation takes effect without restarting the peer", which conflates two different things: a node can always stop *accepting* a peer by deleting its own grant record, but it cannot make the *peer* stop holding a token. The corrected goal states the achievable property and the mechanism for the rest.

## Non-goals

- **A general remote `/api` proxy.** The mesh exposes a fixed operation set with per-operation policy. Anything not in the set is refused by name.
- **Replacing `ctx.peers`.** The mesh implements `PeerTransport`; it does not fork the seam.
- **A distributed session store.** A session keeps exactly one owner. Cross-node access is a request to the owner.
- **Multi-user tenancy.** Pairing is machine-to-machine between installations one person controls. No user model, no roles.
- **WAN or public-internet operation.** A Funnel-exposed mesh port is a misconfiguration to detect and warn about.
- **Automatic peer discovery.** Removed from v1; see G4.
- **Credential rotation as a distinct operation.** Removed; see [the security runbook](../05-operations/02-security-runbook.md#rotation). Rotation is unpair plus re-pair, which is a path the plan already tests.
- **Legacy cookie-authenticated peers.** Removed from the MVP; it contradicts G1 and is tracked separately.
- **Filesystem confinement of a remote turn.** See the honesty statement below.

## The confinement honesty statement

An earlier draft presented `cwdRoots` as a security control. It is not, and the plan now says so in one place that every other document links to.

- `cwdRoots` is a **lexical allowlist on the directory a request may name**. It is checked on the request, before any work starts.
- It does not confine what the agent then does. An agent started inside an allowed directory can read and write elsewhere using ordinary tools, unless its preset provides real confinement.
- It is bypassable through symlinks and junctions if it is implemented as a string prefix test, which is why the implementation must resolve paths before comparing — but even a correct comparison only governs the *starting* directory.
- A `session.prompt` against an **existing** session never names a `cwd` at all, so `cwdRoots` says nothing about it. Every session operation must therefore be authorized against **authoritative session metadata** (the session's own recorded `cwd`), not against the request.
- Real confinement comes from the harness's own sandbox and execution-world machinery: a remote turn must run under a permission preset or execution world that actually restricts filesystem and process access. The grant names that preset; it does not reimplement it.

The plan's threat model therefore classifies "a peer with `task.ask` and no sandboxed preset" as remote code execution with extra steps, and the shipped default grants no write operation at all.

## Constraints inherited from the repository

1. **No new bind literal on `ctx.webServer`.** Its schema is `'127.0.0.1' | '0.0.0.0'` and the CLI refuses `0.0.0.0` for a stated reason. The mesh owns its own listener.
2. **No hardcoded tunables.** One owner resolves an immutable execution specification; see [configuration ownership](../03-implementation/02-types-and-config.md#configuration-ownership).
3. **Registrations are effects** and unwind on unload.
4. **Secrets never in configuration.** `cordis.yml` carries references only.
5. **Model-visible implies logged.** A secret must therefore never be model-visible.
6. **Product-visible plugins need a REAL-composition Loader boot test.**
7. **Bounds apply to the complete emitted value.**
8. **Prefer maintained dependencies over hand-rolling** where they genuinely delete owned code and tests.

## The acceptance bar

The plan is complete when, on a real tailnet with two machines, with the mesh enabled and published on both:

- Two fresh installations pair with one code transfer, and a second attempt with the same code fails.
- An attacker who observes the whole exchange but does not know the code cannot complete it, and both humans see a mismatch.
- A configured node appears in the other's node list within one heartbeat interval and is marked unreachable when stopped.
- A session created on node B is visible from node A, receives intermediate events live while it runs, resumes after a dropped connection without gap or duplication, and can be driven by a prompt issued from node A.
- Revoking on either node stops that node accepting the peer within one request; the peer's cleanup is best effort and is reported as such.
- Killing the network mid-request produces a bounded, named error rather than a hang.
- All of the above while `dsh web` on both machines still binds `127.0.0.1` only, verified by an outside probe against a machine where the GUI is actually running.
