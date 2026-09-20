---
description: "Test tiers, what each tier proves, the repository gate selection workflow, and the case inventory that maps every requirement to a case and a spec file."
kind: "validation"
---

# Test strategy

Seven tiers carry the mesh from a pure function to two machines on a tailnet. Each tier asserts its own layer and nothing above it: a unit case never opens a socket, and a cross-machine case never asserts an internal code path.

## The tiers

| Tier | Prefix | Runs where | Proves | Typical runtime |
|---|---|---|---|---|
| Unit | `U-` | `pnpm run test`, no network | The protocol, the policy, the state machine, the bounds | milliseconds |
| In-process integration | `I-` | `pnpm run test`, two real Cordis trees on loopback | Two services compose, a real HTTP round trip works, disposal is clean | seconds |
| REAL-composition Loader boot | `I-BOOT-` | `pnpm run test` | A test-only `cordis.yml` boots through the real Loader and unwinds | seconds |
| Real-model end-to-end | `I-REAL-` | `pnpm run test:e2e`, self-skips without `DEEPSEEK_API_KEY` | A real cross-node `task.ask` completes against a real model | tens of seconds |
| Cross-machine | `E-` | `assets/mesh-e2e.ps1`, over SSH against a Linux node and an attacker node | The feature works between two operating systems on a real tailnet | minutes |
| Browser | `W-` | `pnpm run test:gui`, `DSH_SNAPSHOT=replay pnpm run test:web` | The UI renders and behaves | seconds to minutes |
| Operational | `O-` | `assets/mesh-doctor.ps1` | The environment is what the plan assumes | seconds |

The in-process tiers share the `I-` prefix in the inventory. `I-BOOT-` and `I-REAL-` are the two that need a different runner from the rest of `pnpm run test`, and both appear explicitly in the acceptance table of [the acceptance criteria](05-acceptance-criteria.md).

## Why the real-model tier exists

`task.ask` is a real cross-node agent workflow: node A's model asks node B to run a turn on B's own harness, with B's own model, tools, workspace, and session store. A recorded-session replay proves what the model-visible request looks like; it cannot prove that the far side completes a turn and returns a terminal result. `I-REAL-01` therefore drives a real model over the loopback pair and self-skips without `DEEPSEEK_API_KEY`, exactly as the repository's other real-API tests do ([testing policy](../../docs/testing.md), `pnpm run test:e2e`).

The keyless recorded-session snapshot for the mesh tools is separate evidence and does not replace it. The snapshot pins what a model sees and what reaches the transcript; the real-model case proves the workflow completes end to end. Both are required, and a passing snapshot never excuses a skipped `I-REAL-01`.

## Why this shape

Three properties of the change drive the allocation:

1. **The pairing protocol is a cryptographic protocol.** It is fully testable offline with pinned vectors, and it must be, because a cross-machine case that only ever succeeds proves almost nothing about the failure paths. Every negative path — wrong code, replayed message, spliced transcript, expired invitation, burned invitation — is a unit case with a fixed input.
2. **The listener binds a socket and runs beside other specs.** Every integration case binds port `0` unless the case is specifically a fixed-port conflict, and each spec owns the paths and child processes it creates.
3. **The interesting failures are between two machines.** Version skew, a dead tailnet, a stale MagicDNS name, a clock difference, and a firewall are not reachable in-process. They are the cross-machine tier, orchestrated over SSH.

## The case inventory is the map

[07-case-inventory.md](07-case-inventory.md) is the mechanical requirement-to-case-to-file map. It defines every `U-`, `I-`, `E-`, `W-`, and `O-` id by prefix `tier-area-n`, states what each case asserts, and names the package and spec file that owns it. It is the single source for case ids; this document and its siblings name ids and link there instead of restating the table.

A script checks the mapping. It is specified at `harness-mesh/assets/verify-case-inventory.ps1`, scans the plan folder for `[UIEWO]-[A-Z0-9]+-[0-9]+` tokens, and fails on any id the inventory does not define. The script is not in `assets/` yet, which currently holds the four runnable artifacts listed in [the assets index](../assets/00-ASSETS.md), so until it lands the mapping is checked by review and an id that appears in a document without an inventory row is a defect in that document.

## Repository gates: select, do not ritualize

Per-commit work follows the repository's [dsh-pre-push-checks](../../.agents/skills/dsh-pre-push-checks/SKILL.md) selection workflow: run the smallest set of checks that covers the outgoing diff, and let CI own exhaustive coverage and the platform matrix. A phase's exit gate in [the phased plan](../03-implementation/03-phased-plan.md) is that selection written for the phase's diff, not a fixed exhaustive list. `pnpm run test:coverage` is the CI coverage gate, per-file 100% on `packages/*/*/src`, and a locally green `pnpm run test` does not imply it; run it once before the phase's last pull request.

| Surface the diff touches | Smallest local evidence |
|---|---|
| Package source | the focused `pnpm run test` for those packages, plus `pnpm run typecheck` when a TypeScript project or generated declaration changed and `pnpm run lint` when source changed |
| Composition or profile rows | `pnpm run verify-cordis-config` |
| Client source or product copy | `pnpm run test:gui`, `pnpm run verify-client-ui-i18n` |
| Model-visible output | `pnpm run test:snapshot` for the new or changed scenario |
| Real provider path | `pnpm run test:e2e` for `I-REAL-01`, with the key |
| Documentation | `pnpm run test:docs`, and `pnpm run doc-sync` for the generated catalogs |
| Any change that can alter visible web output | `DSH_SNAPSHOT=replay pnpm run test:web` |

## What is not tested, and why

- **A live man in the middle on the wire.** Staging one is impractical. The spliced-transcript and impersonated-responder unit cases cover the mechanism an attacker would have to break, and `E-PAIR-02` covers the wrong-code path across two machines.
- **Tailscale's own cryptography.** Out of scope; the mesh treats the tailnet as the transport it is.
- **macOS end to end.** No macOS device is on this tailnet. Every macOS-specific claim is specified from source and is unexercised; the cross-machine suite is parameterized by `assets/nodes.json`, so adding a Mac is a data change.
- **Load and scale.** The mesh is a two-to-ten node control plane. There is a bounded-concurrency case and nothing more.
- **Recovery of a staged pairing after both sides crash.** The protocol's crash matrix states the outcome, which is that the human re-invites; the state machine's expiry cases cover the terminal transition.

## Definition of a green run

A tier is green only when every case in it passes on a clean checkout, beside the other tiers' specs, with no ordering dependency. A case that passes only when it runs alone is a defect in the case, and a case that needs a fixed port is a defect unless the case is specifically a port conflict. A case whose precondition is absent is reported as skipped with the reason and is never reported as passed; the cross-machine driver implements that rule in code.
