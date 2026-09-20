---
description: "The two-node in-process harness, its fault-injection seams, the REAL-composition Loader boot requirement, and the resource-ownership rules every integration spec follows."
kind: "validation"
---

# Unit and integration cases

[The case inventory](07-case-inventory.md) defines every `U-` and `I-` case, what it asserts, the package that owns it, and the spec file it lives in. This document describes the harness those cases run on and names only the highest-value integration cases; it does not restate the case table.

## The two-node in-process harness

Integration cases need two nodes without two machines. The harness boots two real Cordis trees in one worker process and connects them over loopback HTTP:

- **Node B is the serving tree.** It composes `dsh-mesh`, `dsh-mesh-ops`, and `dsh-mesh-agent`, with `listen: { kind: 'loopback', port: 0 }` in the listener config. The T1 shape is exercised separately, on a socket path inside the harness's temp root.
- **Node A is the calling tree.** It composes `dsh-mesh`, `dsh-mesh-remote`, and `dsh-tool-mesh`, and registers the peer through the normal paired-peer path rather than a hand-written transport.
- **Each tree has its own home.** The harness creates a fresh `mkdtemp` directory and points that tree's `DSH_HOME` and credentials provider at it, so identity records, grant records, staged pairings, the audit domain, and session stores never collide between the two trees or with a concurrently running spec.
- **Ports are ephemeral.** The listener binds port `0` and the harness reads the bound port back from the server. No case assumes 8737 or 8443; the one case that uses a fixed port is `U-AGENT-02`, whose subject is the conflict itself.
- **The clock is injected and shared.** Both trees receive the same `now()` function, so an invitation TTL, the pair delivery window, a heartbeat interval, a retry backoff, and the hourly turn budget are advanced by moving the clock rather than by sleeping.
- **Pairing goes through the real handshake.** The harness pairs the two trees through the same state machine the cross-machine tier drives, over the loopback listener, so a case starts from a state the product can reach. Cases that need a different starting state — a withheld operation, an expired grant, a revoked grant — change the serving tree's grant through the product's own configuration path.
- **Teardown is unconditional.** `afterEach` disposes both fibers and then removes the temp roots, on failure and on timeout as well as on success. `U-HMR-02` is the case that proves the socket and its timers are gone after disposal.

The harness is deliberately not a substitute for the Loader boot case: it proves two services compose, while `I-BOOT-01` proves the Loader wires them from YAML.

## Fault-injection seams

Each controlled failure is a seam on the production path, not a monkey-patch. An injected seam that production does not use is a defect: every one of these substitutes a leaf of the shipping implementation.

| Seam | Injected where | Production value | What it simulates | Cases that need it |
|---|---|---|---|---|
| Clock | a `now()` function on the mesh service, provided by the harness | `Date.now` | invitation TTL and expiry, the pair delivery window, retry backoff, presence ages, the hourly turn budget | `U-PAIR-02`, `U-PAIR-12`, `U-BOUND-05`, `U-RETRY-01` |
| Randomness | a `randomBytes` function on the identity and pairing modules | `node:crypto` | fixed node ids, key ids, tokens, and ephemeral scalars, so a transcript is reproducible; also the jitter bound the presence loop draws from | `U-CRYPTO-06`, `U-IDENT-01`, `U-AGENT-05` |
| Tailscale runner | a `runTailscale` function in the `/tailscale` entry | `ctx.subprocess` with a scrubbed environment | a captured `tailscale status --json`, a captured `tailscale serve status`, a missing binary, a non-zero exit | `U-TS-01`..`U-TS-06` |
| Self-session fetch | the `fetch` implementation the self-session module takes | the global `fetch` | a cookie mint that succeeds, a single `401` then success, two consecutive `401`s, a slow mint | `U-SELF-01`..`U-SELF-05` |
| Peer behaviour | a fake peer server in the mesh test kit, handed to the transport as a base URL | a real paired peer | a slow answer, out-of-order frames, a garbage body, a response that exceeds its cap mid-stream | `U-BOUND-02`, `U-BOUND-06`, `U-BOUND-07`, `U-AGENT-03` |
| Credentials store | no seam: the real provider over the temp home | the real provider over the real home | concurrency between two trees, and a restart as a second tree over the same home | `U-IDENT-04`, `U-IDENT-02`, `U-AUDIT-05` |
| Network reachability | no in-process seam; cross-machine only | the real tailnet | `tailscale down`, a stopped listener, a firewall drop | `E-NET-01`..`E-NET-03` |

An integration case that needs one of these asserts through the seam, and a case that changes the seam mid-request restores it in teardown.

## The REAL-composition Loader boot case

Product-visible plugins require a non-unit REAL-composition test: hand-built `ctx.plugin(...)` suites are insufficient, because a composition that the Loader cannot wire still passes them ([package rules](../../packages/AGENTS.md), [testing policy](../../docs/testing.md)). `I-BOOT-01` is that case, and [packages/todo/tool-todo/tests/loader-composition.spec.ts](../../packages/todo/tool-todo/tests/loader-composition.spec.ts) is its model.

The mechanics to copy from that spec:

1. Create a temp root with `mkdtemp` and write a test-only `cordis.yml` into it naming the real rows — the mesh service, the `/tailscale` entry, the operations package, and the agent listener with `enabled: true`, `bindAddress: 127.0.0.1`, `port: 0`.
2. Create a `Context`, set `ctx.baseUrl` to the root with `pathToFileURL`, `await ctx.plugin(Loader)`, and set `ctx.loader.builtins.include = Include`.
3. Supply `ctx.loader.internal.import` mapping each package specifier to the real plugin module, and throw on a specifier the map does not know, so a typo in the composition fails loudly rather than importing something else.
4. `await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })`, then `await ctx.loader.await()`, then `await entry.fiber?.await()` for every entry.
5. Assert the mesh service is reachable from the booted context, that the listener answered the anonymous hello on the port it bound, and that disposing the root fiber unwinds every entry — the same disposal path `U-HMR-01` and `U-HMR-02` exercise at unit level.
6. Remove the temp root in `afterEach`. The composition stays in `tests/`, never in a shipped profile, and the shipped default keeps `enabled: false`.

The boot case is also where a composition-level misconfiguration surfaces. A non-Tailscale bind address, a wildcard grant, and a write grant naming no confinement each reject during load (`U-AGENT-01`, `U-POLICY-02`, `U-POLICY-11`, `U-GRANT-05`), and the Loader turns that rejection into a failed boot rather than a listener that is quietly absent.

## Spec ownership: run concurrently, own everything

Vitest runs spec files concurrently in forked workers, beside the other gate processes, on shared runners. Only the process is isolated; ports, predictable paths, external namespaces, and inherited children are not ([testing policy](../../docs/testing.md), [dsh-ci-test-reliability](../../.agents/skills/dsh-ci-test-reliability/SKILL.md)). Every mesh spec therefore:

- binds port `0` and reads the bound port back, except the case whose subject is a port conflict;
- creates every path with `mkdtemp` under `os.tmpdir()` and never writes into the repository, the developer's own `$DSH_HOME`, or a fixed temp name;
- owns every child process it starts through teardown, including on failure, retry, and timeout, and starts nothing detached;
- keeps shared harness code in `tests/harness.ts`, never in another spec file, because importing a spec re-registers its `describe` block;
- never depends on residue from a previously run spec.

A spec that passes only when it runs alone is a defect in the spec, not an unstable runner.

## The highest-value integration cases

| Case | Why it earns its runtime |
|---|---|
| `I-BOOT-01` | The only case that proves YAML to Loader to live listener; a hand-built tree cannot fail the way a composition fails. |
| `I-PEERS-01` | Pairing registers exactly one `PeerTransport` and unpairing removes it — the seam the shipped `peer_*` tools consume. |
| `I-PEERS-02` | `peer_ask` succeeds against a mesh peer once `task.ask` is granted, with the shipped tool unchanged. |
| `I-PEERS-03` | With `task.ask` denied, the refusal names the disabled operation — the model-visible half of failing loud. |
| `I-REMOTE-01` | Every controller `@Remote` method round-trips through the Typert Gateway with strict argument validation, which is the browser API's contract with the Host. |
| `I-MIRROR-01` | Following a remote session writes nothing into any local session log, the invariant that keeps two harnesses from sharing one transcript. |
| `I-REAL-01` | A real cross-node `task.ask` end to end against a real model; self-skips without a key. |

The remaining integration cases, including `I-SUBAGENT-01` and `I-SSH-TRANSPORT-01` in P6, are in [the case inventory](07-case-inventory.md) with their owners.
