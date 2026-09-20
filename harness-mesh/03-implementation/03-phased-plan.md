---
description: "Phased delivery P0 to P6, recast as mergeable foundations with explicit dependencies, exit gates, and rollback."
kind: "implementation"
---

# Phased plan

The phases are **mergeable foundations in a stack**, not independently usable releases. Each phase is a pull request series that lands on the previous one, and a phase is not merged with an unclosed exit gate. The earlier draft described each phase as independently revertible *and* independently usable, which was false: for example, pairing cannot be exercised without a command to type the code into, and both lived in different phases.

| Phase | Scope | Depends on | Ships a listener? |
|---|---|---|---|
| P0 | Environment preconditions | — | no |
| P1 | `dsh-mesh`: identity, PAKE, pairing state machine, policy, durable audit, tailscale entry | P0 | no |
| P2 | `dsh-mesh-agent` (listener, pairing plane, presence) and `dsh-mesh-cli` (the command surface) | P1 | yes, opt-in |
| P3 | `dsh-mesh-ops` (self-session, read operations) and `dsh-mesh-remote` (outbound transport) | P2 | yes |
| P4 | Write operations, grants, confinement, budgets, `dsh-tool-mesh` | P3 | yes |
| P5 | `dsh-api-mesh-controller` and `dsh-client-ui-mesh` | P4 | yes |
| P6 | Optional transports and follow-ups, each independent | P5 | yes |

A later phase may be reverted without reverting an earlier one, because each adds packages or config rows rather than changing an earlier package's behavior. The reverse is not true, and the table above is the honest statement of that.

## The check ladder

Every phase's exit gate is stated as a **selection**, not a full-suite run, per the repository's [dsh-pre-push-checks](../../.agents/skills/dsh-pre-push-checks/SKILL.md) workflow: locally run the smallest set that covers the outgoing diff, and let CI own exhaustive coverage. The earlier draft listed `pnpm run test:coverage` plus `typecheck`, `lint`, `constraints`, and `hygiene` as a per-phase ritual, which is exactly the reflex the policy forbids.

Common to every phase and stated once here:

- `pnpm run test` for the packages the diff touches, filtered to them.
- `pnpm run typecheck` when the diff changes a TypeScript project or a generated declaration.
- `pnpm run lint` when the diff changes source.
- `pnpm run test:docs` when the diff changes documentation; it must stay green, including the translation-pairing gate.
- `pnpm run test:coverage` before the phase's **last** pull request, because per-file coverage is a CI gate and a locally green `test` does not imply it.
- No phase runs the full repository suite locally.

## P0 — Environment preconditions

**Not code.** Two of these are unmet on the reference environment and are the reason several cases can only be reported as skipped.

| Item | State | Action |
|---|---|---|
| Tailscale up on both nodes | verified | none |
| MagicDNS resolving | verified | none |
| HTTPS certificates enabled for the tailnet | **assumed** | Verify; if unavailable, use topology T3, which needs no certificate |
| Mesh port free | verified: 8737 unused on this machine | re-check after a restart |
| A unix socket path the user can create (T1) | unverified | `XDG_RUNTIME_DIR` or `$DSH_HOME/run/mesh.sock`; the doctor checks it |
| SSH from this machine to the Linux node | **unmet**: port 22 open on three hosts, every user rejected `publickey` | Install a key; see [cross-machine e2e](../04-validation/03-cross-machine-e2e.md) |
| Node and pnpm on the Linux node | **assumed** | The doctor prints what it finds |
| macOS node | **absent** from this tailnet | Covered by the repository platform matrix and by inspection only |

**Exit gate:** `scripts/mesh-doctor.ps1` reports every precondition green or explicitly skipped.

## P1 — The definition package

**Scope.** `packages/mesh/mesh` and its `/tailscale` entry. No socket, no protocol, no UI.

**Deliverables**

- The service, identity (with signed challenges), the SPAKE2 pairing state machine and its RFC 9382 vectors, policy resolution into a frozen execution specification, and the durable bounded audit domain.
- The `/tailscale` entry providing `ctx.meshAddresses` as an optional service.
- `docs/subsystems/mesh.md` and its pair; the group page; the package READMEs; the **proposed Agent Note** with its bilingual pair; regenerated `docs/config-catalog.md`.

**Exit gate:** focused `pnpm run test` for the new package; `pnpm run typecheck`, `pnpm run lint`, `pnpm run test:docs`; `pnpm run test:coverage` before the last PR of the phase.

Cases that must pass: `U-CRYPTO-*`, `U-PAIR-*`, `U-POLICY-*`, `U-IDENT-*`, `U-AUDIT-*`, `U-HMR-01`.

**Rollback:** delete the group. Nothing references it yet.

**Risk:** the PAKE is the security core and the only place a defect is silent. RFC 9382 Appendix B vectors are run against this implementation as a structural check, and the edwards25519 M/N constants are asserted against the values published in RFC 9382 §6. A dependency decision on `@noble/curves` and a `pnpm.overrides` decision on `@noble/hashes` belong to this phase's first pull request.

## P2 — Listener, pairing plane, and the command surface

**Scope.** `dsh-mesh-agent` and `dsh-mesh-cli`, together, because pairing cannot be exercised without a way to type the code.

**Deliverables**

- The listener with bind validation for all three topologies, the fixed route table, the request pipeline (bounded body, version envelope, schema parse once, authenticate, resolve specification, dispatch), and the presence loop.
- The CLI bundle and its profile template: `invite`, `pair`, `approve`, `deny`, `nodes`, `unpair`, `audit`, each with `--json`.
- The masked terminal prompt and the non-terminal stdin path. No shipped DSH code reads a secret from a terminal today, so this is new code and it is covered by a case.

**Exit gate:** focused package tests; `pnpm run verify-cordis-config` for the new rows and the profile template; `pnpm run test:docs`; `pnpm run test:coverage` before the last PR.

Cases: `U-AGENT-*`, `U-CLI-*`, `I-BOOT-01`, `U-HMR-02`, and the two-machine pairing cases `E-PAIR-01` through `E-PAIR-10` plus `E-PRES-01`..`E-PRES-04`.

**Rollback:** set `enabled: false` (the shipped default) or remove the rows. Nothing durable is written except staged paired records, which are inert without a listener.

**Risk:** the profile template addition touches `apps/cli/package.json`, the installation-owned profile tuples, the profile spec fixture, and the generated config catalog. Commander subcommands inside an app's own program are supported by `parseCmdline` but **no shipped bundle uses one yet**, so this is a first-of-its-kind path and is worth an explicit boot test.

## P3 — Read operations and the outbound transport

**Scope.** `dsh-mesh-ops` and `dsh-mesh-remote`.

**Deliverables**

- The self-session client, the exhaustive operation map, and the read handlers: `node.status`, `session.list`, `session.read`, `session.transcript`, `session.follow`.
- `MeshPeerTransport` registered into `ctx.peers` per paired node.
- The `mesh/inbound` session event and the `meshCallChain` projection.

**An honest statement about the shipped peer tools.** `peer_ask` maps to `task.ask`, which is a **write** operation and is denied until P4. In P3, `peer_ask` therefore fails with `MESH_NOT_ALLOWED` naming the disabled operation. `peer_sessions` and `peer_transcript` work. The earlier draft claimed the shipped tools "work unchanged" while placing the operation they depend on in a later phase; that is corrected here, and the successful `peer_ask` case moves to P4.

**Exit gate:** focused package tests; `DSH_SNAPSHOT=replay pnpm run test:web` only if a browser artifact changed, which it has not in this phase.

Cases: `U-SELF-*`, `U-BOUND-*`, `U-LOOP-01`, `U-RETRY-01`, `I-PEERS-01`, `I-PEERS-03`, `E-READ-01`..`E-READ-05`, `E-STREAM-01`..`E-STREAM-05`, `E-LOOP-01`, `E-NET-01`..`E-NET-05`.

**Rollback:** remove the `mesh-remote` and `mesh-ops` rows; the listener keeps serving pairing and presence.

**Risk:** the self-session is the most sensitive new mechanism. It is never persisted, never logged, and never returned to a peer, and a case asserts that even at trace level.

## P4 — Writes, grants, confinement, and the model tools

**Scope.** The write handlers, the grant editor's backing service, and `dsh-tool-mesh`.

**Deliverables**

- `session.create`, `session.prompt`, `session.cancel`, `session.search`, `task.ask`, all denied by default.
- Confinement enforcement: a grant naming a write operation must name a permission preset or execution world, and the plugin refuses to load without one.
- Budgets at every boundary, idempotency for write operations, and the `refuse-writes` audit-failure policy.
- The three model tools. Approval is exercised through the **CLI** (`dsh mesh approve`, `dsh mesh deny`), which already exists from P2, so this phase has **no dependency on P5**.
- A self-skipping real-model end-to-end case for `task.ask`, because a cross-node task is a real agent workflow: it self-skips without a key, exactly as the repository's other real-API tests do, and it is not replaced by the keyless snapshot.
- A keyless recorded-session snapshot for the mesh tools' model-visible output.

**Exit gate:** `pnpm run test:snapshot` for the new scenario; `pnpm run test:coverage` before the last PR.

Cases: `U-TOOL-*`, `U-GRANT-*`, `U-BOUND-03`..`U-BOUND-06`, `U-IDEM-01`, `E-WRITE-01`..`E-WRITE-06`, `E-DENY-01`..`E-DENY-07`, `E-BUDGET-01`..`E-BUDGET-03`, `E-APPROVE-01`, `E-APPROVE-02`, `I-PEERS-02`, `I-REAL-01`.

**Rollback:** set `defaultAllow` to the read-only set. The handlers stay implemented and unreachable.

**Risk:** this is the phase that can produce remote code execution. The shipped default grants no write operation, the grant editor renders the confinement sentence next to every write toggle, and a composition that grants a write without a confining preset fails to load.

## P5 — Browser API and UI

**Scope.** `dsh-api-mesh-controller` and `dsh-client-ui-mesh`.

**Deliverables**

- The administration methods **and** the peer-session methods the UI actually needs: `mesh/peerSessions`, `mesh/peerSessionPage`, `mesh/peerSessionTranscript`, `mesh/peerSessionFollow` (a stream method), and `mesh/submitTask`, plus `mesh/setGrant` and `mesh/setSettings` mutation paths.
- The panel, the pairing dialog, the grant editor, the audit view, and the remote-session views with their own client resource model, cancellation, reconnection, and disposal ownership.
- Locale dictionaries for every product string.

**Exit gate:** `pnpm run test:gui`; `pnpm run verify-client-ui-i18n`; `DSH_SNAPSHOT=replay pnpm run test:web`; `pnpm run test:coverage` before the last PR.

Cases: `I-REMOTE-01`, the `W-*` cases, and `U-CODE-01`.

**Rollback:** remove the `ui-mesh` and controller rows. The CLI keeps every capability except the interactive dialog.

**Risk:** the invitation code crosses the Remote wire here, to the node's own authenticated browser only. A test asserts it never reaches an audit record, a log line, or a session event.

## P6 — Optional follow-ups

Each is independently revertible and none gates acceptance.

| Item | Why | Cost |
|---|---|---|
| SSH-stdio mesh transport | Pairing and control where only SSH is available | A second `PeerTransport`; the registry already accepts one |
| Mesh-backed `subagent` provider | The peer control-plane note names it as the natural follow-up | A new provider package over `ctx.mesh` |
| Remote session mirroring in the local UI tree | Convenience | Must not write to a local session log; a mirror is a separate view |
| Automatic peer discovery | Removes manual endpoint entry | Needs a rendezvous and an advertisement format that do not exist; explicitly **not** in v1 |
| Legacy cookie-authenticated peers | Reach a stock `dsh web` node | Contradicts G1 and adds a credential surface; tracked separately |
| A SPAKE2 variant over ristretto255 | Cofactor-free group | ristretto255 is not an RFC 9382 ciphersuite; it needs derived M/N constants, so it is a protocol version, not a config flag |

## Verification limits, stated plainly

**Closed since the first revision:** SSH to the Linux peer. `ssh bsa-contabo` reaches `vmi2916953` (Linux 6.8.0, Node v22.22.2, pnpm 12.4.2) with the default key, and the doctor reports that node's `ssh`, `remote-runtime`, `tailscale-peer`, and `address-current` rows green. The cross-machine tier now has a real peer, and `E-00` is verified rather than blocked.

**Still open:**

1. **macOS is absent from this tailnet.** Every macOS-specific claim — the socket path, the LocalAPI variant, the Tailscale binary invocation — is specified from source and from the repository's own platform handling, not exercised. The suite is parameterized by node descriptors, so adding a Mac is a data change.
2. **No third machine accepts a key.** `kimi`, `tigs-pi`, and `ai` reject every user tried, so the unpaired-node and cloned-identity roles are played by a **second harness home on the driver machine**. That is a genuinely different node identity, grant store, and credential pair — which is what those cases need — but it is not a different operating system, and the difference is stated rather than glossed.
3. **SSH is one-way.** `ssh 100.122.125.15` from the peer is refused, so the driver is pull-based: W drives L. A push model would need the reverse direction, and the plan never assumes it.
