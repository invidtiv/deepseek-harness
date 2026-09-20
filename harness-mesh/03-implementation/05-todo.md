---
description: "The working checklist, ordered by phase, every item gated by a case defined in the case inventory."
kind: "implementation"
---

# Todo

Every item is one commit's worth of work or less. The **Gate** column names a case id that [the case inventory](../04-validation/07-case-inventory.md) defines and assigns to a spec file; an id that is not in that inventory is not a gate. Items with no gate are documentation, environment, or packaging work.

## P0 — Environment preconditions

- [ ] `P0-01` Confirm HTTPS certificates are enabled for the tailnet, or decide to run T3. **Gate:** `O-01`
- [ ] `P0-02` Confirm port 8737 is free, and choose the unix socket path for T1. **Gate:** `O-02`
- [ ] `P0-03` Install an SSH public key on the Linux node; confirm passwordless `ssh <node> true`. **Gate:** `E-00`
- [ ] `P0-04` Confirm the Linux node's Node and pnpm satisfy the engine range. **Gate:** `E-01`
- [ ] `P0-05` Finish `assets/mesh-doctor.ps1`: it currently checks tailnet membership, address drift, runtime, bind address, and Funnel exposure; add the certificate and socket-path rows. **Gate:** `O-03`, `O-04`
- [ ] `P0-06` Keep `assets/nodes.json` current from `tailscale status --json`; the documented stale `kimi` entry in `~/.ssh/config` is the failure mode this guards.
- [ ] `P0-07` Add a macOS descriptor marked pending, so the suite covers it as data when a Mac joins.

## P1 — The definition package

### Scaffolding

- [ ] `P1-01` Create `packages/mesh/00-index.md`-equivalent group page (`README.md` plus its `.zh.md` pair) linking `docs/subsystems/mesh.md`.
- [ ] `P1-02` Create `packages/mesh/mesh/` with manifest, tsconfig, src, tests, README and pair. **Gate:** `pnpm run constraints`
- [ ] `P1-03` Add the `tsconfig.host.json` reference and regenerate the source-plane alias block. **Gate:** `pnpm run typecheck`
- [ ] `P1-04` Add the group row to `packages/README.md`.
- [ ] `P1-05` Add `packages/mesh/mesh/src/tailscale.ts` as the second entry point.

### Dependency decision

- [ ] `P1-06` Add `@noble/curves` at a pinned range and decide the `@noble/hashes` alignment: the repo already carries `2.3.0` through `packages/experimental/webworker-runtime`, and `@noble/curves` pins an exact version, so either add a `pnpm.overrides` entry or accept two copies in the lockfile. Record the decision in the package README and the Agent Note.
- [ ] `P1-07` Confirm `@noble/curves` is not already reachable and that `THIRD_PARTY_NOTICES.md` is updated. **Gate:** `pnpm run hygiene`

### PAKE

- [ ] `P1-08` Implement `src/pake.ts`: RFC 9382 SPAKE2 over edwards25519, the scrypt `w` derivation, the transcript, `Ke`/`Ka`/`KcA`/`KcB`, `cA`/`cB`, the SAS, and the seal key. **Gate:** `U-CRYPTO-01`..`U-CRYPTO-05`, `U-CRYPTO-08`..`U-CRYPTO-11`
- [ ] `P1-09` Pin the RFC 9382 Appendix B vectors and run them with the group swapped. **Gate:** `U-CRYPTO-06`
- [ ] `P1-10` Assert the edwards25519 M and N constants against the published values. **Gate:** `U-CRYPTO-07`
- [ ] `P1-11` Pin the negative vectors: spliced handshakes, wrong code, tampered `pB`. **Gate:** `U-CRYPTO-12`

### Identity

- [ ] `P1-12` Implement `src/identity.ts`: load-or-create through `modifyRecord`, Ed25519 keypair, fingerprint, display name default, and **challenge signing**. **Gate:** `U-IDENT-01`, `U-IDENT-02`, `U-IDENT-05`
- [ ] `P1-13` Implement divergence detection. **Gate:** `U-IDENT-03`
- [ ] `P1-14` Assert single creation under concurrency. **Gate:** `U-IDENT-04`

### Pairing state machine

- [ ] `P1-15` Implement `src/pairing.ts` with the states, transitions, TTL sweep, attempt counting, delivery window, and staging, over an injected clock. **Gate:** `U-PAIR-01`..`U-PAIR-05`, `U-PAIR-07`..`U-PAIR-10`, `U-PAIR-12`
- [ ] `P1-16` Collapse every non-matching invitation outcome to one response. **Gate:** `U-PAIR-06`
- [ ] `P1-17` Assert no code reaches any event, audit record, or log. **Gate:** `U-PAIR-11`
- [ ] `P1-18` Assert terminal transitions zero their key material. **Gate:** `U-PAIR-09`

### Policy

- [ ] `P1-19` Implement `src/policy.ts`, resolving a frozen execution specification. **Gate:** `U-POLICY-01`..`U-POLICY-09`, `U-POLICY-12`
- [ ] `P1-20` Resolve paths before comparison; deny `..`, symlinks out of a root, non-absolute paths, device-shaped paths, and separator translation. **Gate:** `U-POLICY-04`..`U-POLICY-07`
- [ ] `P1-21` Authorize session operations against the session's recorded metadata. **Gate:** `U-POLICY-13`
- [ ] `P1-22` Fail the load for a write grant with no confinement. **Gate:** `U-POLICY-11`
- [ ] `P1-23` Keep one collapsed unauthenticated code while recording the local classification. **Gate:** `U-POLICY-10`

### Audit

- [ ] `P1-24` Declare the `mesh-audit` domain and open it through `ctx.storageDomain`; do not choose a backend. **Gate:** `U-AUDIT-01`
- [ ] `P1-25` Implement count and age retention with pruning on the write boundary. **Gate:** `U-AUDIT-01`
- [ ] `P1-26` Create the local correlation key under `mesh/audit` and hash arguments with HMAC. **Gate:** `U-AUDIT-03`
- [ ] `P1-27` Implement the failure policy, including `refuse-writes` and the dropped-record count. **Gate:** `U-AUDIT-04`
- [ ] `P1-28` Assert that no record carries content and that records survive a restart. **Gate:** `U-AUDIT-02`, `U-AUDIT-05`

### Service and tailscale entry

- [ ] `P1-29` `export default class MeshService extends Service` with `ctx.mesh` and every documented method. **Gate:** `U-SVC-01`
- [ ] `P1-30` Every registration through `ctx.effect`, with the disposal proof. **Gate:** `U-HMR-01`
- [ ] `P1-31` Emit the four typed events; verify `mesh/request` delegates through `next()`. **Gate:** `U-EVT-01`
- [ ] `P1-32` Implement the `/tailscale` entry with scrubbed-environment subprocess calls and the fixtures. **Gate:** `U-TS-01`..`U-TS-06`

### Documentation

- [ ] `P1-33` Write the **proposed Agent Note** and its bilingual pair; run the supersession check. **Gate:** `pnpm run test:docs`
- [ ] `P1-34` Write `docs/subsystems/mesh.md` and its pair, plus the index entry. **Gate:** `pnpm run test:docs`
- [ ] `P1-35` Package READMEs with Model Experience and Known Limitations; record the invariant-companion omission and its reason. **Gate:** `pnpm run test:docs`
- [ ] `P1-36` Regenerate `docs/config-catalog.md`. **Gate:** `pnpm run test:docs`

## P2 — Listener, pairing plane, command surface

- [ ] `P2-01` Create `packages/mesh/mesh-agent/`.
- [ ] `P2-02` Implement the listener with bind validation for the unix socket, loopback, and Tailscale topologies. **Gate:** `U-AGENT-01`
- [ ] `P2-03` Report a taken port or socket path by name. **Gate:** `U-AGENT-02`
- [ ] `P2-04` Implement the pipeline in fixed order with a single schema parse. **Gate:** `U-AGENT-03`, `U-AGENT-06`
- [ ] `P2-05` Implement the nine routes and nothing else. **Gate:** `U-AGENT-04`
- [ ] `P2-06` Implement the anonymous hello with exactly its documented fields, and the token-required mode. **Gate:** `U-AGENT-08`, `U-DISCOVERY-01`
- [ ] `P2-07` Record an advisory identity header as claimed and prove it never changes an authorization outcome. **Gate:** `U-AGENT-07`
- [ ] `P2-08` Implement the presence loop, single-flight per peer and jittered. **Gate:** `U-AGENT-05`
- [ ] `P2-09` Assert teardown releases the socket and every timer. **Gate:** `U-HMR-02`
- [ ] `P2-10` Create `packages/mesh/mesh-cli/` as a bundle with a profile template. **Gate:** `I-BOOT-01`
- [ ] `P2-11` Implement the commander subcommands; this is the first shipped bundle to use one, so prove it in the boot test. **Gate:** `U-CLI-04`, `U-CLI-05`
- [ ] `P2-12` Implement the masked terminal prompt and the non-terminal stdin path; no shipped code reads a terminal secret today, so this is new. **Gate:** `U-CLI-02`
- [ ] `P2-13` Implement the interactive SAS gate with no bypass flag. **Gate:** `U-CLI-01`
- [ ] `P2-14` Implement `--json` output. **Gate:** `U-CLI-03`
- [ ] `P2-15` Register the profile template, add the bundle to the install anchor, update the profile fixture, and regenerate the config catalog. **Gate:** `pnpm run verify-cordis-config`
- [ ] `P2-16` Execute every command line the runbooks print. **Gate:** `E-OPS-06`

## P3 — Read operations and the outbound transport

- [ ] `P3-01` Create `packages/mesh/mesh-ops/` and `packages/mesh/mesh-remote/`.
- [ ] `P3-02` Implement the self-session with the single re-mint rule. **Gate:** `U-SELF-01`..`U-SELF-04`
- [ ] `P3-03` Prove the self-session cookie never reaches an audit record, a trace log, an event, or a persisted record. **Gate:** `U-SELF-05`
- [ ] `P3-04` Implement the exhaustive operation map with no runtime registration. **Gate:** `U-OPMAP-01`
- [ ] `P3-05` Implement the read handlers with strict per-operation schemas. **Gate:** `U-AGENT-06`, `E-READ-01`..`E-READ-05`
- [ ] `P3-06` Implement `session.follow` over the upgrade with authorization before the socket is accepted. **Gate:** `E-STREAM-01`..`E-STREAM-05`
- [ ] `P3-07` Apply the stream and response bounds to every envelope, not only prompts and streams. **Gate:** `U-BOUND-01`, `U-BOUND-02`, `U-BOUND-06`, `U-BOUND-07`
- [ ] `P3-08` Write the `mesh/inbound` event and the `meshCallChain` projection. **Gate:** `U-ORIGIN-01`, `U-ORIGIN-03`
- [ ] `P3-09` Propagate hops and visited on outbound commands. **Gate:** `U-ORIGIN-02`, `U-LOOP-01`
- [ ] `P3-10` Implement the reconnect backoff and the successful-contact-only presence rule. **Gate:** `U-RETRY-01`, `U-REMOTE-01`
- [ ] `P3-11` Register the outbound `PeerTransport` and prove the shipped tools see it. **Gate:** `I-PEERS-01`
- [ ] `P3-12` Prove `peer_ask` reports the disabled operation rather than a generic failure. **Gate:** `I-PEERS-03`

## P4 — Writes, grants, confinement, model tools

- [ ] `P4-01` Implement the write handlers, denied by default. **Gate:** `E-WRITE-01`
- [ ] `P4-02` Implement `task.ask` as create, prompt, follow to `turn/end`. **Gate:** `E-WRITE-03`, `I-PEERS-02`
- [ ] `P4-03` Make every write idempotent under its key. **Gate:** `U-IDEM-01`
- [ ] `P4-04` Enforce confinement: refuse the load without a named preset, and `MESH_CONFINEMENT_REQUIRED` at request time. **Gate:** `U-GRANT-05`, `E-WRITE-07`
- [ ] `P4-05` Implement grants over settings plus credentials, with only the hash stored inbound. **Gate:** `U-GRANT-01`, `U-GRANT-03`
- [ ] `P4-06` Implement local revocation and prove the next request fails. **Gate:** `U-GRANT-02`, `E-DENY-02`, `E-OPS-02`
- [ ] `P4-07` Warn at startup for a write grant with no expiry. **Gate:** `U-GRANT-04`
- [ ] `P4-08` Implement budgets at every boundary. **Gate:** `U-BOUND-03`..`U-BOUND-05`, `E-BUDGET-01`..`E-BUDGET-03`
- [ ] `P4-09` Implement `approval: always` through the CLI, and the bounded failure when no operator answers. **Gate:** `E-APPROVE-01`, `E-APPROVE-02`
- [ ] `P4-10` Create `packages/mesh/tool-mesh/` with the three tools; there is no pairing tool. **Gate:** `U-TOOL-01`..`U-TOOL-06`
- [ ] `P4-11` Add the keyless recorded-session snapshot for the tools' model-visible output. **Gate:** `pnpm run test:snapshot`
- [ ] `P4-12` Add the self-skipping real-model end-to-end case for a cross-node task. **Gate:** `I-REAL-01`
- [ ] `P4-13` Add the preset rows and resolver-manifest entries. **Gate:** `pnpm run verify-cordis-config`
- [ ] `P4-14` Prove the denial, cwd, preset, and unknown-operation paths. **Gate:** `E-DENY-01`, `E-DENY-03`..`E-DENY-07`
- [ ] `P4-15` Prove a genuine nested A to B to A call is refused. **Gate:** `E-LOOP-01`, `E-LOOP-02`
- [ ] `P4-16` Prove grant edits take effect and survive a restart. **Gate:** `E-GRANT-01`..`E-GRANT-05`

## P5 — Browser API and UI

- [ ] `P5-01` Create `packages/api/mesh-controller/` with the administration methods. **Gate:** `I-REMOTE-01`
- [ ] `P5-02` Add the peer-session methods and the stream method the panel needs. **Gate:** `I-REMOTE-01`
- [ ] `P5-03` Add the settings and grant mutation paths. **Gate:** `I-REMOTE-01`
- [ ] `P5-04` Generate the Typert artifacts. **Gate:** `pnpm run build:lib`
- [ ] `P5-05` Create `packages/client/ui-mesh/` with the three registration surfaces. **Gate:** `pnpm run verify-client-packages`
- [ ] `P5-06` Settings section, sidebar panel, command palette entries. **Gate:** `W-01`
- [ ] `P5-07` Pairing dialog in both modes, with the mandatory comparison gate and the masked field. **Gate:** `W-02`, `W-03`
- [ ] `P5-08` The remote session view with its resource model: cancellation, reconnection from the cursor, and disposal on unload. **Gate:** `W-04`, `W-08`
- [ ] `P5-09` Audit view with the partial-view notice. **Gate:** `W-05`
- [ ] `P5-10` Funnel banner with the exact remediation. **Gate:** `W-06`
- [ ] `P5-11` Grant editor with the confinement sentence on every write toggle. **Gate:** `W-07`
- [ ] `P5-12` Locale dictionaries for every product string. **Gate:** `pnpm run verify-client-ui-i18n`
- [ ] `P5-13` Prove the code reaches only the local authenticated browser. **Gate:** `U-CODE-01`
- [ ] `P5-14` Prove a followed remote session writes nothing into a local log. **Gate:** `I-MIRROR-01`

## P6 — Optional follow-ups

- [ ] `P6-01` SSH-stdio transport. **Gate:** `I-SSH-TRANSPORT-01`
- [ ] `P6-02` Mesh-backed subagent provider. **Gate:** `I-SUBAGENT-01`
- [ ] `P6-03` Remote session mirroring as a separate view, with the no-local-write proof.
- [ ] `P6-04` Automatic discovery, when a rendezvous and an advertisement format exist.
- [ ] `P6-05` Legacy cookie-authenticated peers, tracked separately because it contradicts G1.
- [ ] `P6-06` A ristretto255 SPAKE2 variant, which is a protocol version rather than a config flag.

## Cross-cutting

- [ ] `X-01` Every new `src` file is inside the per-file coverage gate; no bare `v8 ignore`.
- [ ] `X-02` Every bound has one declaring package; a bound declared twice is a defect.
- [ ] `X-03` Every registration is an effect with a disposal case.
- [ ] `X-04` Every spec owns its socket, path, and child process and passes beside other specs.
- [ ] `X-05` No new model-visible output without a session event behind it.
- [ ] `X-06` Every bound applies to the complete emitted value.
- [ ] `X-07` No document describes `cwdRoots` as confinement, or a proxy identity as an authorization input.
- [ ] `X-08` No document prints the pairing code on a command line.
- [ ] `X-09` The case inventory stays complete: a script scans the folder for case ids and fails on any id it does not define.
- [ ] `X-10` `pnpm run test:docs` stays green, including the translation-pairing gate; no new file in this folder may be named `README.md`.
