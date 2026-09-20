---
description: "Plan for linking two DeepSeek Harness instances across machines on a Tailscale tailnet: research, proposal, implementation plan, and validation, corrected after design review."
kind: "plan-index"
---

# Harness Mesh — linking two DSH instances over Tailscale

## What this folder is

A complete, testable plan for making two `dsh web` instances on different machines — Windows, Linux, macOS — aware of each other, able to share sessions, and able to command each other, joined by a Tailscale tailnet, with a safe code-based pairing flow.

No harness code is changed by this plan. Claims about the harness are read from source in this checkout and cited by path; claims about the network come from live probes of this machine's tailnet, recorded in [environment evidence](01-research/03-environment-evidence.md) and re-derived by [the observed run](04-validation/06-observed-run.md).

**This folder is non-authoritative scratch material.** The durable decision lives in the proposed Agent Note [Mesh — pairing and federation between Harness instances](../.agents/notes/proposed/feature/2026-09-20-mesh-harness-federation.md), with its bilingual pair. If the two ever disagree, the Agent Note wins.

## Revision status

This is the second revision. A design review rejected the first with 18 standards corrections and 12 specification corrections, all of which are applied:

| Was | Now |
|---|---|
| A hand-built X25519 + HKDF pairing construction, with a PAKE deferred to an optional phase | **SPAKE2, RFC 9382, over edwards25519, mandatory in v1.** The old construction left an offline verifier for the 40-bit code |
| Source pinning, per-source rate limits, and `tailscale whois` applied under every topology | **Topology-dependent caller identity.** Under `tailscale serve` the backend's peer is the local proxy, so those controls do not exist and the design says so |
| A model-facing `mesh_pair(node, code)` tool and a `--code` flag | **Both removed.** A tool call is durable model-visible history, and argv leaks into shell history and process inspection |
| A one-shot sealed token delivery, with token ownership reversed | **A staged, acknowledged, idempotent bidirectional commit** with compensating revocation and a crash matrix |
| `args: unknown`, with bounds on prompts and streams only | **A normative per-operation schema table**, parsed once, with response bounds on every envelope |
| `cwdRoots` presented as a security control | **An explicit honesty statement**: it is a lexical allowlist, not confinement, and writes require a confining preset |
| An Ed25519 key that signed nothing | **The key signs the pairing transcript and challenge responses**, with divergence-based clone detection |
| An invented `dsh mesh` subcommand, and an E2E that ran `node apps/cli/lib/bin.js` | **A shipped bundle plus profile template**, and the E2E uses the installed `dsh` |
| A closed operation set *and* a runtime `registerOperation` | **A fixed exhaustive map with one owner** |
| A volatile audit ring with plain hashes | **A durable bounded domain with HMAC-keyed correlation** and a defined failure policy |
| A model-initiated pairing flag | **The capability does not exist**, rather than being disabled |
| Legacy cookie peers in the MVP | **Removed**, tracked separately |
| Phase-wide exhaustive local gates | **The `dsh-pre-push-checks` selection workflow** |
| Case ids with no home | **[A case inventory](04-validation/07-case-inventory.md)** mapping every id to its owner and spec file |
| A claim that this subtree is exempt from documentation gates | **Corrected**: it is not, and the named files were moved out of the pairing corpus |

## The recommendation in one screen

Do **not** widen the Web GUI's listener. `dsh web` refuses `--host 0.0.0.0` on purpose, because its `/api` surface is a complete tool-capable Host API. Instead ship a **new plugin family that owns a separate, opt-in listener**, keeps the GUI loopback-only, and reaches the other machine through Tailscale.

| Layer | Choice | Why |
|---|---|---|
| Reachability | One of three topologies: **T1** `tailscale serve` to a unix socket (default), **T2** `tailscale serve` to a loopback port, **T3** a direct bind on the node's Tailscale address | The harness has no TLS support at all; Tailscale owns certificates and encryption. T1 removes the local TCP spoofing path entirely |
| Discovery | Explicitly configured endpoints, plus `tailscale status --json` for address resolution | The earlier "automatic discovery" requirement contradicted its own optional phase; discovery is out of v1 |
| Pairing | **SPAKE2 (RFC 9382, edwards25519)** with an out-of-band 8-symbol Crockford code, a 6-digit SAS, and tokens sealed under the agreed key | No offline verifier for the code; a relay cannot complete it; both humans can detect an attack |
| Credential | Each side mints the token it will present, keeps it, and the other stores only its hash keyed by `keyId`; staged, acknowledged, idempotent | Recoverable across every crash and message-loss boundary |
| Identity | An Ed25519 node key that **signs the pairing transcript and challenge responses** | It is actually used, and divergence between two live nodes sharing one identity is detectable |
| Authorization | **The paired token, and nothing else.** Proxy identity headers are recorded as claimed | Serve headers are forgeable by any local process, absent for Funnel, and unpopulated for tagged devices |
| Control plane | A `PeerTransport` registered into the existing `ctx.peers` seam | The shipped peer tools reach mesh nodes with no change to those packages; the read tools work on a fresh pairing and `peer_ask` needs the write grant |
| Session sharing | The owner serves; a node drives its own loopback `/api` through an in-memory self-session, filtered by grants | Live follow, cancellation, and search already exist as Remote methods; two harnesses never write one log |
| Commanding | `mesh_command` (model) plus a Mesh panel (human), through one grant policy | One policy engine, two callers |
| Audit | A durable, bounded, prunable storage domain with HMAC-keyed argument correlation | A volatile ring cannot support an incident-response claim |

## Deliverables

| Document | What it answers |
|---|---|
| [01-research/01-dsh-internals.md](01-research/01-dsh-internals.md) | How the harness works today: plugin model, web server, `/api` fence and cookie auth, the `peer/` control plane, the SDK, webhook, SSH |
| [01-research/02-cordis-plugins.md](01-research/02-cordis-plugins.md) | How to author a plugin, and the correction that "cortix" does not exist — the framework is Cordis |
| [01-research/03-environment-evidence.md](01-research/03-environment-evidence.md) | Live probes: tailnet inventory, MagicDNS, `tailscale serve` state, `$DSH_HOME` layout, session file format, SSH reachability |
| [01-research/04-prior-art-and-gaps.md](01-research/04-prior-art-and-gaps.md) | Every existing surface that does part of this, and the gap each leaves |
| [02-proposal/01-problem-and-goals.md](02-proposal/01-problem-and-goals.md) | Requirements G1–G10 with their corrections, non-goals, and the confinement honesty statement |
| [02-proposal/02-architecture.md](02-proposal/02-architecture.md) | Components, identity, caller identity per topology, the normative route and authentication table, operation flow, grants, failure model |
| [02-proposal/03-pairing-protocol.md](02-proposal/03-pairing-protocol.md) | The SPAKE2 wire specification, the bidirectional commit, the crash matrix, and the vectors to pin |
| [02-proposal/04-threat-model.md](02-proposal/04-threat-model.md) | Assets, adversaries, mitigations, residual risk, and the failure-oracle rule |
| [02-proposal/05-alternatives-rejected.md](02-proposal/05-alternatives-rejected.md) | Every cheaper option and the concrete reason it fails |
| [03-implementation/01-package-plan.md](03-implementation/01-package-plan.md) | Eight packages, manifests, the command surface, the audit owner, and the composition rows |
| [03-implementation/02-types-and-config.md](03-implementation/02-types-and-config.md) | Types, per-operation wire schemas, configuration ownership, error codes |
| [03-implementation/03-phased-plan.md](03-implementation/03-phased-plan.md) | Phases P0–P6 as mergeable foundations, with dependencies and exit gates |
| [03-implementation/04-client-ui-plan.md](03-implementation/04-client-ui-plan.md) | The browser half, with the Host API it consumes and the client resource model |
| [03-implementation/05-todo.md](03-implementation/05-todo.md) | The checklist, every item gated by an inventory case |
| [04-validation/01-test-strategy.md](04-validation/01-test-strategy.md) | Tiers including the real-model end-to-end tier, and the repository gates |
| [04-validation/02-unit-and-integration.md](04-validation/02-unit-and-integration.md) | The two-node harness and the fault-injection seams |
| [04-validation/03-cross-machine-e2e.md](04-validation/03-cross-machine-e2e.md) | The SSH-orchestrated Windows-to-Linux suite |
| [04-validation/04-edge-cases.md](04-validation/04-edge-cases.md) | The edge-case matrix |
| [04-validation/05-acceptance-criteria.md](04-validation/05-acceptance-criteria.md) | The definition of done |
| [04-validation/06-observed-run.md](04-validation/06-observed-run.md) | What the plan's own tooling actually reported, including a retraction |
| [04-validation/07-case-inventory.md](04-validation/07-case-inventory.md) | Every case id, its assertion, its owning package, and its spec file |
| [04-validation/08-rerun-after-ssh.md](04-validation/08-rerun-after-ssh.md) | The re-run that closes the SSH precondition, with node L's rows now green |
| [05-operations/01-tailscale-runbook.md](05-operations/01-tailscale-runbook.md) | The three topologies, Funnel avoidance, and verification |
| [05-operations/02-security-runbook.md](05-operations/02-security-runbook.md) | Key handling, revocation (there is no rotation operation), and incident response |
| [05-operations/03-troubleshooting.md](05-operations/03-troubleshooting.md) | Symptom to cause to fix |
| [assets/](assets/00-ASSETS.md) | Runnable scaffolding: node descriptors, the doctor, the provisioning script, the suite driver |
| [The Agent Note](../.agents/notes/proposed/feature/2026-09-20-mesh-harness-federation.md) | The durable decision, with its bilingual pair |

## Runnable artifacts

Three of the four files under [assets/](assets/00-ASSETS.md) execute, and two were run while this plan was written:

```powershell
pwsh harness-mesh/assets/mesh-doctor.ps1
pwsh harness-mesh/assets/mesh-e2e.ps1 -Suite all
```

Their output is recorded in [the observed run](04-validation/06-observed-run.md), including the correction that the first version of the driver **reported a pass for a check it had not performed**: it probed a port on a machine where no harness was running, and a refused connection proved nothing. The driver now requires the listener to be running before a refusal counts, and reports those cases as skipped.

## Reading order

[The Agent Note](../.agents/notes/proposed/feature/2026-09-20-mesh-harness-federation.md) for the decision, then [the environment evidence](01-research/03-environment-evidence.md) for the machines, then [the architecture](02-proposal/02-architecture.md), then the implementation and validation halves together — every phase names the inventory cases that gate it.

## Evidence standard

- **Verified** — read from source in this checkout, or produced by a command run against this machine or this tailnet. The path or command is quoted.
- **Specified** — a decision this plan makes. It is not implemented anywhere yet.
- **Assumed** — not verifiable from here, with the reason and the check that would settle it.

One gap is restated wherever it matters: **macOS is not on this tailnet.**

The SSH gap that blocked the cross-machine tier is **closed**. `ssh bsa-contabo` reaches `vmi2916953` — Linux 6.8.0, Node v22.22.2, pnpm 12.4.2 — with the default key, and the doctor reports that node's `ssh`, `remote-runtime`, `tailscale-peer`, and `address-current` rows green. Two limits remain and are stated rather than implied: no third machine on this tailnet accepts a key, so the unpaired-node role is played by a second harness home on the driver machine; and SSH is one-way, so the driver is pull-based.

## Dev Note

This subtree is planning material. It is **not** exempt from the repository's documentation gates — an earlier revision claimed it was, and `pnpm run test:docs` disproved that by failing the translation-pairing gate on two files named `README.md`. Those are now `00-INDEX.md` and `assets/00-ASSETS.md`, which puts them outside the pairing corpus, and the durable content lives in the Agent Note above.
