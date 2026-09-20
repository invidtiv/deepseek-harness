---
description: "The mechanically checked requirement to case to owner inventory: every case id, what it asserts, the package that owns it, and the spec file it lives in."
kind: "validation"
---

# Case inventory

Every case id used anywhere in this plan appears here exactly once, with its owner. A case id that appears in a document but not in this file is a defect; the check is a script (`assets/verify-case-inventory.ps1`) that scans the plan folder for `[UIEWO]-[A-Z0-9]+-[0-9]+` tokens and fails on any id this file does not define.

The **Spec file** column is the path inside the owning package. Tests live at package level under `tests/`, never in `src/__tests__/`.

## Unit cases

### `dsh-mesh` — `packages/mesh/mesh/tests/`

| Id | Asserts | Spec file |
|---|---|---|
| `U-CRYPTO-01` | `normalizeCode` accepts every documented spelling | `pake.spec.ts` |
| `U-CRYPTO-02` | Crockford folding: `I`/`L` to `1`, `O` to `0`, `U` to `V` | `pake.spec.ts` |
| `U-CRYPTO-03` | Malformed codes are rejected with a named error, never coerced | `pake.spec.ts` |
| `U-CRYPTO-04` | The transcript is length-prefixed, so field boundaries are unambiguous | `pake.spec.ts` |
| `U-CRYPTO-05` | SPAKE2 is symmetric: both sides derive the same `Ke`, `cA`, `cB`, SAS, and seal key | `pake.spec.ts` |
| `U-CRYPTO-06` | RFC 9382 Appendix B vectors run against this implementation with the group swapped | `pake-vectors.spec.ts` |
| `U-CRYPTO-07` | The edwards25519 M and N constants equal the values published in RFC 9382 section 6 | `pake-vectors.spec.ts` |
| `U-CRYPTO-08` | `w` derivation is deterministic, never zero, and changes with the pairingId | `pake.spec.ts` |
| `U-CRYPTO-09` | The SAS is always six digits and never leading-zero-stripped | `pake.spec.ts` |
| `U-CRYPTO-10` | Seal and unseal round-trip; a changed ciphertext, tag, IV, or AAD fails | `pake.spec.ts` |
| `U-CRYPTO-11` | Every secret comparison uses `timingSafeEqual` on equal-length buffers | `pake.spec.ts` |
| `U-CRYPTO-12` | Negative: spliced handshakes, a wrong code, and a tampered `pB` each fail the right confirmation | `pake-vectors.spec.ts` |
| `U-PAIR-01` | Happy path through open, claimed, pending, approved, committed | `pairing.spec.ts` |
| `U-PAIR-02` | Expiry from `open` | `pairing.spec.ts` |
| `U-PAIR-03` | Expiry from `claimed` | `pairing.spec.ts` |
| `U-PAIR-04` | Attempt exhaustion burns the invitation | `pairing.spec.ts` |
| `U-PAIR-05` | A failed `cA` burns immediately, even with attempts remaining | `pairing.spec.ts` |
| `U-PAIR-06` | Every non-matching invitation outcome collapses to `MESH_PAIR_UNKNOWN` | `pairing.spec.ts` |
| `U-PAIR-07` | A denied invitation never yields a sealed payload | `pairing.spec.ts` |
| `U-PAIR-08` | The open-invitation cap fails rather than evicting | `pairing.spec.ts` |
| `U-PAIR-09` | The sweep removes terminal invitations and zeroes their key material | `pairing.spec.ts` |
| `U-PAIR-10` | The global rate limit admits below and refuses at the boundary | `pairing.spec.ts` |
| `U-PAIR-11` | No emitted event, audit record, or log line contains the code | `pairing.spec.ts` |
| `U-PAIR-12` | Staged records survive and expire exactly at `pairDeliveryWindowMs` | `pairing.spec.ts` |
| `U-POLICY-01` | Operation allowlist matches exact names and `session.*` globs | `policy.spec.ts` |
| `U-POLICY-02` | A bare `*` grant is refused by validation | `policy.spec.ts` |
| `U-POLICY-03` | A `cwd` inside a root is admitted | `policy.spec.ts` |
| `U-POLICY-04` | `..` traversal is denied after resolution | `policy.spec.ts` |
| `U-POLICY-05` | A symlink escaping a root is denied | `policy.spec.ts` |
| `U-POLICY-06` | An empty `cwdRoots` denies every `cwd` | `policy.spec.ts` |
| `U-POLICY-07` | Non-absolute, device-shaped, and Windows-separator paths are denied | `policy.spec.ts` |
| `U-POLICY-08` | Case handling follows the host filesystem | `policy.spec.ts` |
| `U-POLICY-09` | A preset outside the grant is denied | `policy.spec.ts` |
| `U-POLICY-10` | An expired grant denies, and the caller still sees one collapsed code | `policy.spec.ts` |
| `U-POLICY-11` | A write operation without a confinement fails the load | `policy.spec.ts` |
| `U-POLICY-12` | Every limit resolves to the minimum of node, grant, and request | `policy.spec.ts` |
| `U-POLICY-13` | Session operations are authorized against the session's recorded metadata, not the request | `policy.spec.ts` |
| `U-IDENT-01` | First call creates the identity and persists it | `identity.spec.ts` |
| `U-IDENT-02` | A second process over the same home yields the same id and fingerprint | `identity.spec.ts` |
| `U-IDENT-03` | Fingerprint or node-id divergence raises `MESH_IDENTITY_CONFLICT` | `identity.spec.ts` |
| `U-IDENT-04` | Two concurrent `identity()` calls create exactly one record | `identity.spec.ts` |
| `U-IDENT-05` | A challenge signature verifies, and a tampered nonce does not | `identity.spec.ts` |
| `U-SVC-01` | Every declared method exists and returns its documented shape for the empty case | `service.spec.ts` |
| `U-EVT-01` | The four events emit with documented payloads; `mesh/request` is a waterfall that delegates | `events.spec.ts` |
| `U-AUDIT-01` | Retention is bounded by count and by age, and prune keeps the newest | `audit.spec.ts` |
| `U-AUDIT-02` | No record contains a prompt, path, token, cookie, or code | `audit.spec.ts` |
| `U-AUDIT-03` | Argument correlation is keyed: two different keys give different hashes, one key is stable | `audit.spec.ts` |
| `U-AUDIT-04` | The configured failure policy is honoured: `refuse-writes` refuses, `degrade` counts drops | `audit.spec.ts` |
| `U-AUDIT-05` | Records survive a simulated restart | `audit.spec.ts` |
| `U-HMR-01` | Disposing the fiber removes exactly its contribution and leaves others | `hmr.spec.ts` |
| `U-TS-01` | Self address and name parse from a captured `tailscale status --json` fixture | `tailscale.spec.ts` |
| `U-TS-02` | Trailing dot normalized; IPv4 precedes IPv6; IPv6 is bracketed in URLs | `tailscale.spec.ts` |
| `U-TS-03` | An offline peer is present with its last-seen time | `tailscale.spec.ts` |
| `U-TS-04` | A captured `tailscale serve status` parses into listeners with scheme, port, and target | `tailscale.spec.ts` |
| `U-TS-05` | A missing binary degrades to no facts, logs once, and does not fail the load | `tailscale.spec.ts` |
| `U-TS-06` | The captured fixture with a live Funnel listener is reported exposed for that port and not the others | `tailscale.spec.ts` |

### `dsh-mesh-ops` — `packages/mesh/mesh-ops/tests/`

| Id | Asserts | Spec file |
|---|---|---|
| `U-SELF-01` | The self-session mint obtains a cookie and uses it on the next call | `self-session.spec.ts` |
| `U-SELF-02` | The cookie is reused, not re-minted per request | `self-session.spec.ts` |
| `U-SELF-03` | A `401` triggers exactly one re-mint and the retry succeeds | `self-session.spec.ts` |
| `U-SELF-04` | Two consecutive `401`s fail with `MESH_SELF_SESSION_UNAVAILABLE` rather than looping | `self-session.spec.ts` |
| `U-SELF-05` | The cookie never appears in an audit record, a trace log, an event, or a persisted record | `self-session.spec.ts` |
| `U-OPMAP-01` | The operation map is exhaustive over `MeshOperation` and has no runtime registration path | `operations.spec.ts` |
| `U-BOUND-01` | A follow stream closes at `streamSeconds` | `bounds.spec.ts` |
| `U-BOUND-02` | A follow stream closes at exactly `streamBytes`, tested with a multibyte payload | `bounds.spec.ts` |
| `U-BOUND-03` | Exactly `maxPromptBytes` is accepted; one byte more is `413` | `bounds.spec.ts` |
| `U-BOUND-04` | The second turn at a concurrency of one is refused; the first completes | `bounds.spec.ts` |
| `U-BOUND-05` | The hourly cap refuses the next turn and rolls over on the injected clock | `bounds.spec.ts` |
| `U-BOUND-06` | A response over `responseBytes` is truncated with a marker, and the complete value is within the cap | `bounds.spec.ts` |
| `U-BOUND-07` | The same bound is applied to list, page, search, transcript, and error envelopes | `bounds.spec.ts` |
| `U-IDEM-01` | Two writes with one idempotency key start one turn and return the same result | `idempotency.spec.ts` |
| `U-ORIGIN-01` | The `mesh/inbound` event is written and the projection derives hops and visited | `call-chain.spec.ts` |
| `U-ORIGIN-02` | A nested outbound command inherits `hops + 1` and the visited set | `call-chain.spec.ts` |
| `U-ORIGIN-03` | An unknown `ignorable` event does not refuse the log | `call-chain.spec.ts` |

### `dsh-mesh-agent` — `packages/mesh/mesh-agent/tests/`

| Id | Asserts | Spec file |
|---|---|---|
| `U-AGENT-01` | Bind validation accepts a unix socket, loopback, and a Tailscale address; refuses everything else with `MESH_BIND_NOT_TAILSCALE` | `listener.spec.ts` |
| `U-AGENT-02` | A taken port reports `MESH_PORT_IN_USE` naming the conflict; the first listener survives | `listener.spec.ts` |
| `U-AGENT-03` | Pipeline order: oversized-and-unauthenticated gets 413; unauthenticated-and-disallowed gets the collapsed 401; parsed-then-authorised reaches no Remote call when denied | `pipeline.spec.ts` |
| `U-AGENT-04` | The route table is exact: `/`, `/plugins/x`, `/api/session/list`, and traversal paths all answer an empty 404 | `routes.spec.ts` |
| `U-AGENT-05` | Presence is single-flight per peer, jittered, and fully torn down on dispose | `presence.spec.ts` |
| `U-AGENT-06` | Unknown fields, wrong types, fractional counts, and over-long strings are refused per operation | `schemas.spec.ts` |
| `U-AGENT-07` | An advisory identity header is recorded as claimed and never changes an authorization outcome | `caller-identity.spec.ts` |
| `U-AGENT-08` | The anonymous hello returns exactly the documented fields and nothing else | `hello.spec.ts` |
| `U-HMR-02` | After dispose the same socket path and port can be rebound in the same spec | `listener.spec.ts` |

### `dsh-mesh-remote` — `packages/mesh/mesh-remote/tests/`

| Id | Asserts | Spec file |
|---|---|---|
| `U-LOOP-01` | At `maxHops`, and with the target already visited, the request is refused before a socket opens | `loop.spec.ts` |
| `U-RETRY-01` | Failures follow the configured backoff to the ceiling and stop at the offline threshold | `retry.spec.ts` |
| `U-REMOTE-01` | Presence is derived from successful contact only; a peer answering errors is offline | `presence.spec.ts` |

### `dsh-tool-mesh` — `packages/mesh/tool-mesh/tests/`

| Id | Asserts | Spec file |
|---|---|---|
| `U-TOOL-01` | Each tool's parameter and output schemas validate the documented shapes | `tools.spec.ts` |
| `U-TOOL-02` | An empty node list renders a stable sentence, not an empty string | `tools.spec.ts` |
| `U-TOOL-03` | An oversized result is capped on the complete rendered value including the marker | `tools.spec.ts` |
| `U-TOOL-04` | There is no pairing tool, and no tool or result contains a code, token, or cookie | `tools.spec.ts` |
| `U-TOOL-05` | `exec.signal` aborts an in-flight command and ends the local wait | `tools.spec.ts` |
| `U-TOOL-06` | A denied operation reports the operation name rather than a generic failure | `tools.spec.ts` |

### `dsh-mesh-cli` — `packages/mesh/mesh-cli/tests/`

| Id | Asserts | Spec file |
|---|---|---|
| `U-CLI-01` | The interactive `pair` command refuses to proceed without a SAS confirmation, and no flag bypasses it | `pair-command.spec.ts` |
| `U-CLI-02` | The code is read from a masked prompt on a TTY and from stdin otherwise; no argv path accepts it | `code-input.spec.ts` |
| `U-CLI-03` | `--json` emits one machine-readable document per command | `json-output.spec.ts` |
| `U-CLI-04` | Every documented command parses; each runbook command line is executed in the documentation pass | `commands.spec.ts` |
| `U-CLI-05` | A usage error routes through the launcher exit request with a non-zero code | `commands.spec.ts` |

### `dsh-mesh` and `dsh-api-mesh-controller` — cross-package

| Id | Asserts | Spec file |
|---|---|---|
| `U-GRANT-01` | A grant round-trips through settings and credentials; only the hash is stored inbound | `packages/mesh/mesh/tests/grant.spec.ts` |
| `U-GRANT-02` | `revokeLocal` deletes the inbound hash and the grant; the next request fails | `packages/mesh/mesh/tests/grant.spec.ts` |
| `U-GRANT-03` | An unknown stored record version is refused, never parsed leniently | `packages/mesh/mesh/tests/grant.spec.ts` |
| `U-GRANT-04` | A write grant without `expiresAt` produces the startup warning | `packages/mesh/mesh/tests/grant.spec.ts` |
| `U-GRANT-05` | A write grant without `confinement` fails the load | `packages/mesh/mesh/tests/grant.spec.ts` |
| `U-CODE-01` | The invitation code reaches only the local authenticated browser: it is absent from every audit record, log line, session event, and tool result | `packages/api/mesh-controller/tests/code-disclosure.spec.ts` |
| `U-DISCOVERY-01` | With `discovery.enabled: false` the hello requires a token and returns the same document | `packages/mesh/mesh-agent/tests/hello.spec.ts` |

## Integration cases

| Id | Asserts | Owner and spec file |
|---|---|---|
| `I-BOOT-01` | A test-only `cordis.yml` naming the mesh, tailscale, ops, and agent rows boots through the real Loader, binds an ephemeral socket, and unwinds every entry | `packages/mesh/mesh-agent/tests/loader-composition.spec.ts` |
| `I-PEERS-01` | Pairing registers exactly one `PeerTransport`; unpairing removes it | `packages/mesh/mesh-remote/tests/peers.spec.ts` |
| `I-PEERS-02` | `peer_ask` against a mesh peer succeeds once `task.ask` is granted | `packages/mesh/mesh-remote/tests/peers.spec.ts` |
| `I-PEERS-03` | With `task.ask` denied, `peer_ask` reports the disabled operation by name | `packages/mesh/mesh-remote/tests/peers.spec.ts` |
| `I-REMOTE-01` | Every controller `@Remote` method round-trips through the Typert Gateway with strict argument validation | `packages/api/mesh-controller/tests/remote.spec.ts` |
| `I-MIRROR-01` | Following a remote session writes nothing into any local session log | `packages/api/mesh-controller/tests/mirror.spec.ts` |
| `I-REAL-01` | A real cross-node `task.ask` completes end to end against a real model; self-skips without a key | `packages/mesh/tool-mesh/tests/real-ask.e2e.ts` |
| `I-SUBAGENT-01` | A mesh-backed subagent provider returns a settled result and leaves the transcript on the peer | `packages/mesh/mesh-remote/tests/subagent.spec.ts` (P6) |
| `I-SSH-TRANSPORT-01` | The SSH-stdio transport satisfies the same `PeerTransport` contract against a local fake | `packages/mesh/mesh-remote/tests/ssh-transport.spec.ts` (P6) |

## Cross-machine cases

Owner: the driver `assets/mesh-e2e.ps1` with node descriptors from `assets/nodes.json`. There is no per-case spec file; each case is a driver function, and the driver's `-Case` filter selects one.

| Id | Asserts |
|---|---|
| `E-00` | Passwordless SSH reaches the Linux node |
| `E-01` | The remote runtime satisfies the engine range |
| `E-02` | Provisioning produces a clean worktree at the requested commit |
| `E-03` | Both harnesses bind their web ports |
| `E-04` | Both mesh listeners answer the hello |
| `E-05` | `tailscale serve` publishes each node's endpoint, tailnet-only, never Funnel |
| `E-PAIR-01` | A full pairing completes, both fingerprints match, both sides report the same SAS |
| `E-PAIR-02` | A wrong code burns the invitation, and the correct code then also fails |
| `E-PAIR-03` | A replayed confirm is refused and the stored pairing is unchanged |
| `E-PAIR-04` | An expired invitation is refused |
| `E-PAIR-05` | Attempt exhaustion burns the invitation |
| `E-PAIR-06` | A denial leaves no partial record on either side |
| `E-PAIR-07` | An unapproved invitation times out with a named code |
| `E-PAIR-08` | A third node confirming a claimed invitation is refused |
| `E-PAIR-09` | A recorded wire capture contains no code |
| `E-PAIR-10` | A cloned identity is refused with `MESH_IDENTITY_CONFLICT` |
| `E-PAIR-11` | The exact command line the responder prints executes successfully |
| `E-PAIR-12` | The ack path: a lost ack is retried within the delivery window and commits |
| `E-PRES-01` | A paired node appears online within one interval |
| `E-PRES-02` | Stopping a peer moves it offline within the failure threshold, with a last-success age |
| `E-PRES-03` | Restarting a peer restores presence without re-pairing |
| `E-PRES-04` | A wrong recorded address falls back or reports a named error, never a silent hang |
| `E-READ-01` | The peer's sessions list with titles and activity times |
| `E-READ-02` | A page matches the peer's own API for the same cursor |
| `E-READ-03` | The transcript is bounded, oldest first |
| `E-READ-04` | An unknown session maps to a named error, never a 500 |
| `E-READ-05` | A session over 500 KB returns bounded, marked, and in bounded time |
| `E-STREAM-01` | Intermediate events arrive while the remote turn is still running |
| `E-STREAM-02` | A stream closes at the byte cap with a distinguishable reason |
| `E-STREAM-03` | A stream closes at the time cap while the peer's turn continues |
| `E-STREAM-04` | A dropped stream resumes from the cursor with no gap and no duplicate |
| `E-STREAM-05` | An unauthenticated upgrade is refused with no half-open socket |
| `E-STREAM-06` | A prompt continues an existing remote session and the transcript is continuous |
| `E-WRITE-01` | A freshly paired peer cannot prompt |
| `E-WRITE-02` | A create inside the roots succeeds in the requested directory |
| `E-WRITE-03` | `task.ask` returns the answer, stop reason, elapsed, session id, and usage |
| `E-WRITE-04` | Cancel ends the peer's turn and retains the pending inbox |
| `E-WRITE-05` | Search results come from the peer's own index |
| `E-WRITE-06` | A write survives a peer restart |
| `E-WRITE-07` | A write without a confining preset fails to load the peer's composition |
| `E-DENY-01` | An unpaired node gets one collapsed 401 and no session data |
| `E-DENY-02` | After revocation the very next request fails, with no cached acceptance |
| `E-DENY-03` | An expired grant fails, with the same collapsed code |
| `E-DENY-04` | A `cwd` outside the roots is refused |
| `E-DENY-05` | An unlisted preset is refused |
| `E-DENY-06` | An operation outside the set is a 404 |
| `E-DENY-07` | A traversal path is a 404 |
| `E-BUDGET-01` | The prompt cap admits the limit and refuses one byte more |
| `E-BUDGET-02` | The second simultaneous turn is refused; the first completes |
| `E-BUDGET-03` | The third turn in an hour with a cap of two is refused |
| `E-LOOP-01` | A genuine A to B to A nested tool call is refused with `MESH_HOP_LIMIT` |
| `E-LOOP-02` | A request whose visited set already contains the target is refused before any socket |
| `E-NET-01` | Tailscale down on the peer yields a named error within the bound, no hang |
| `E-NET-02` | Tailscale restored recovers without re-pairing |
| `E-NET-03` | A stopped listener yields `MESH_UNAVAILABLE` while the node still shows online from Serve |
| `E-NET-04` | A ten-minute clock skew does not break verification or presence ages |
| `E-NET-05` | A relayed path still completes, reporting higher latency |
| `E-ARCH-01` | The GUI is unreachable from another machine **while it is running there**, verified by probing the listener first |
| `E-ARCH-02` | Nothing but the hello answers on the published endpoint |
| `E-ARCH-03` | The anonymous hello returns only its documented fields |
| `E-ARCH-04` | No Funnel listener covers a mesh port |
| `E-ARCH-05` | A forged advisory identity header does not change any authorization outcome |
| `E-OPS-01` | Restarting both harnesses preserves pairing, grants, and audit |
| `E-OPS-02` | Revoking on one node stops that node accepting the peer on the next request |
| `E-OPS-03` | Re-pairing after revocation mints a new key id |
| `E-OPS-04` | A peer advertising only a future protocol yields `426` naming both versions |
| `E-OPS-05` | No code appears in either node's logs or audit after the whole run |
| `E-OPS-06` | Every runbook command line parses and runs against a live node |
| `E-APPROVE-01` | With `approval: always`, a local CLI approval admits the turn |
| `E-APPROVE-02` | With `approval: always` and no operator, the request fails at the approval bound rather than hanging |
| `E-GRANT-01` | `setGrant` narrows an operation and the next request is refused |
| `E-GRANT-02` | A grant updated while a request is in flight does not affect the admitted request |
| `E-GRANT-03` | A peer's advertised inbound permissions match what it actually enforces |
| `E-GRANT-04` | Revocation during a running turn does not abort it, and refuses the next |
| `E-GRANT-05` | A grant edit survives a peer restart |

## Browser cases

Owner: `packages/client/ui-mesh/tests/`.

| Id | Asserts | Spec file |
|---|---|---|
| `W-01` | The settings section renders identity, listener state, peers, and diagnostics from stubbed Host data | `settings.client.spec.tsx` |
| `W-02` | The approval view shows the verified fingerprint, the claimed identity labelled as claimed, and the SAS, and Approve stays disabled until the comparison is confirmed | `pairing.client.spec.tsx` |
| `W-03` | The initiator view prompts with a masked field, shows a mismatch panel on a failed confirmation, and never offers a retry with the same code | `pairing.client.spec.tsx` |
| `W-04` | The remote session view streams, shows reconnect state, resumes from the cursor, and reports a gap | `remote-session.client.spec.tsx` |
| `W-05` | The audit view pages, filters, and shows a partial-view notice when records were dropped | `audit.client.spec.tsx` |
| `W-06` | The Funnel banner renders with the exact remediation command for the exposed port | `diagnostics.client.spec.tsx` |
| `W-07` | A write toggle in the grant editor renders the remote-execution sentence and the confinement requirement | `grant-editor.client.spec.tsx` |
| `W-08` | Unloading the plugin aborts every follow subscription and disposes the panel store | `lifecycle.client.spec.tsx` |

## Operational cases

Owner: `assets/mesh-doctor.ps1`.

| Id | Asserts |
|---|---|
| `O-01` | HTTPS certificate availability is reported |
| `O-02` | The mesh port or socket path is free |
| `O-03` | The doctor exits 0 with every row green or explicitly skipped |
| `O-04` | The doctor exits 1 when a row is forced red |

## Requirement traceability

| Goal | Cases |
|---|---|
| G1 pair without a browser or a pre-shared secret | `E-PAIR-01`, `E-PAIR-11`, `U-CLI-02`, `E-OPS-06` |
| G2 keep the code out of every durable or inspectable channel | `E-PAIR-09`, `E-OPS-05`, `U-PAIR-11`, `U-TOOL-04`, `U-CODE-01`, `U-CLI-02` |
| G3 safe against an active network attacker | `U-CRYPTO-05`, `U-CRYPTO-06`, `U-CRYPTO-12`, `E-PAIR-02` |
| G4 know the configured peers | `E-PRES-01`..`E-PRES-04`, `U-REMOTE-01` |
| G5 share sessions live | `E-READ-01`..`E-READ-05`, `E-STREAM-01`..`E-STREAM-06`, `I-MIRROR-01`, `W-04` |
| G6 command across nodes | `E-WRITE-01`..`E-WRITE-06`, `I-PEERS-02`, `I-REAL-01`, `E-LOOP-01` |
| G7 fail loud and consistently | `E-DENY-01`..`E-DENY-07`, `U-PAIR-06`, `U-POLICY-10`, `E-NET-01` |
| G8 inspectable after the fact | `U-AUDIT-01`..`U-AUDIT-05`, `E-OPS-01` |
| G9 revocable with honest semantics | `U-GRANT-02`, `E-OPS-02`, `E-OPS-03`, `E-DENY-02`, `E-GRANT-04` |
| G10 add no new exposure | `E-ARCH-01`..`E-ARCH-05`, `U-AGENT-04`, `U-AGENT-08` |
