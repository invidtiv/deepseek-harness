---
description: "Definition of done: the observable check behind each goal, the repository-level acceptance table, the conditions under which the plan is not complete, and the sign-off checklist."
kind: "validation"
---

# Acceptance criteria

The plan is done when every check below passes on a real tailnet with at least two machines, and each check names the command or the case that produces it. Case ids are defined by [the case inventory](07-case-inventory.md); an id that is not in that inventory is not a gate.

## The timed workflow, and its starting state

The one-minute pairing budget starts when the mesh is **enabled and published on both nodes**. It does not start from a fresh install: a fresh install ships `enabled: false`, and publishing a node still needs `tailscale serve`, a certificate for the tailnet or a topology that needs none, and the ACL that lets the two nodes reach each other. Those steps are untimed preconditions with their own failures and recoveries, listed here because a pairing that fails inside the minute is usually one of them.

| Step | Command | Pass condition | Failure and recovery |
|---|---|---|---|
| Enable the listener on each node | set the `mesh-agent` row's `enabled: true` in the node's composition | the listener binds and `GET /mesh/v1/hello` answers on the node itself | bind refused with `MESH_BIND_NOT_TAILSCALE` → use loopback plus Serve, or the node's own Tailscale address |
| Publish the endpoint on each node | `tailscale serve --bg --https=8444 unix:/run/user/1000/dsh-mesh.sock` | `tailscale serve status` shows one tailnet-only mapping per node | no certificate for the tailnet → run topology T3, which needs none; the port is already published (8443 is, on the reference machine) → choose another and update `assets/nodes.json` |
| Confirm no Funnel listener covers the mesh port | `tailscale serve status`, then `assets/mesh-doctor.ps1` | no Funnel endpoint names a mesh port | exposed → `tailscale funnel --https=<publishedPort> off`, then restart, because the listener also warns at startup |
| Create the invitation | `dsh mesh invite` on the responder | the code, the endpoint, and a complete command line are printed | `maxOpenInvitations` reached → the command fails by name and never evicts an open invitation |
| Pair | paste the printed command line on the initiator, approve on the responder | both sides commit within one minute of the invitation being displayed | wrong code or a declined comparison → the invitation burns and a new one is required |
| Confirm the node list | `dsh mesh nodes` on both nodes | each configured peer is listed with identity, published endpoint, paired state, and last successful contact | a peer missing → check its descriptor and wait one presence interval |

## G1 — Pair without a browser or a pre-shared secret

| Check | Command | Pass condition |
|---|---|---|
| One command creates an invitation | `dsh mesh invite` on the responder | it prints the code, the endpoint, and a complete command line carrying the public `pairingId` |
| The printed command line is the whole initiator procedure | paste the responder's exact output on the initiator | it prompts for the code and commits after the responder approves, which is `E-PAIR-11` |
| A lost acknowledgement still commits | drop the ack inside the delivery window | the retry commits, with no half-paired state left behind (`E-PAIR-12`) |
| The code is typed, never passed in arguments | `dsh mesh pair` reads a masked prompt on a TTY and stdin otherwise | no flag accepts a code, and neither `ps` output nor shell history contains it (`U-CLI-02`) |
| The responder will not proceed without the comparison | the interactive `pair` and approval flows | neither side commits without an explicit confirmation that the SAS strings match (`U-CLI-01`) |
| No browser, cookie, or environment variable participates | inspect both harness homes after the pair | no `DSH_PEER_COOKIE`, no manual cookie file, no browser opened |

**Cases:** `E-PAIR-01`, `E-PAIR-11`, `U-CLI-02`, `E-OPS-06`.

## G2 — Keep the code out of every durable or inspectable channel

| Check | Pass condition |
|---|---|
| The wire | a recorded capture of the whole exchange contains no message body and no header carrying the code (`E-PAIR-09`) |
| The logs and the audit rings | after the whole run, neither node's log nor its audit ring contains any code used in the run (`E-OPS-05`) |
| Events and tool results | no emitted event payload and no tool result contains the code (`U-PAIR-11`, `U-TOOL-04`) |
| The browser path | the code reaches only the node's own authenticated browser, and never an audit record, a log line, or a session event (`U-CODE-01`) |
| Process arguments and model history | no shipped flag accepts a code, and no model tool accepts one (`U-CLI-02`, `U-TOOL-04`) |

**Cases:** `E-PAIR-09`, `E-OPS-05`, `U-PAIR-11`, `U-TOOL-04`, `U-CODE-01`, `U-CLI-02`.

## G3 — Safe against an active network attacker

| Check | Pass condition |
|---|---|
| A wrong code cannot complete | the confirm fails and the invitation burns, including a later attempt with the correct code (`E-PAIR-02`) |
| A spliced transcript cannot complete | both confirmation checks fail for every splice point (`U-CRYPTO-12`) |
| The agreement itself is pinned | RFC 9382 Appendix B vectors run against this implementation with the group swapped, and the edwards25519 M and N constants equal the published values (`U-CRYPTO-06`, `U-CRYPTO-07`) |
| Both humans see the same SAS on success | the two outputs match character for character (`E-PAIR-01`) |
| A mismatch is visible to the human | the initiator shows the fingerprint as verified, the claimed identity labelled as claimed, and a mismatch panel on failure, and never offers a retry with the same code (`W-02`, `W-03`) |
| The code never reaches the wire or a log | the capture and both audit rings scan clean (`E-PAIR-09`, `E-OPS-05`) |

**Cases:** `U-CRYPTO-05`, `U-CRYPTO-06`, `U-CRYPTO-12`, `E-PAIR-02`.

## G4 — Know the configured peers

Automatic discovery is out of scope for v1: nodes are configured by endpoint, and the anonymous hello is a capability probe rather than a sweep. Acceptance is that every **configured** node is accounted for.

| Check | Pass condition |
|---|---|
| Every configured node is listed | the node list shows display name, fingerprint, published endpoint, paired state, and the time of the last successful contact (`E-PRES-01`, `U-REMOTE-01`, `W-01`) |
| Presence is accurate | a stopped peer goes offline within the configured failure threshold with a last-success age, and a restarted peer returns online without re-pairing (`E-PRES-02`, `E-PRES-03`) |
| A stale address never hangs | a wrong recorded address falls back to another recorded address or reports a named error within the bound (`E-PRES-04`) |
| Nothing is discovered that was not configured | an unlisted node is not probed, not listed, and not paired; with `discovery.enabled: false` the hello requires a token and returns the same document (`U-DISCOVERY-01`) |
| The anonymous surface stays minimal | the hello returns only protocol versions, node id, display name, fingerprint, and the caller's own paired state (`U-AGENT-08`) |

**Cases:** `E-PRES-01`..`E-PRES-04`, `U-REMOTE-01`.

## G5 — Share sessions, live

| Check | Pass condition |
|---|---|
| List | the peer's sessions with titles and activity times (`E-READ-01`) |
| Read | a page matches what the peer's own API returns for the same cursor (`E-READ-02`) |
| Transcript | reduced messages, oldest first, bounded per message (`E-READ-03`) |
| Bounds and errors | a session over 500 KB returns bounded, marked, and in bounded time; an unknown session is a named error, never a 500 (`E-READ-04`, `E-READ-05`) |
| Live delivery during the turn | intermediate events arrive at the follower **while the remote turn is still running**, not only the final committed message (`E-STREAM-01`) |
| Reconnect from a cursor | a dropped stream resumes from the last seen cursor with no gap and no duplicate (`E-STREAM-04`) |
| Continue a remote session | a prompt continues an existing remote session and the transcript is continuous across the join (`E-STREAM-06`) |
| Caps are distinguishable | the stream closes at the byte cap with a distinguishable reason, and at the time cap while the peer's turn continues (`E-STREAM-02`, `E-STREAM-03`) |
| Authorization before the upgrade | an unauthenticated upgrade is refused with no half-open socket (`E-STREAM-05`) |
| Neutral | following a remote session writes nothing into any local session log (`I-MIRROR-01`) |
| In the browser | the remote session view streams, shows reconnect state, resumes from the cursor, and reports a gap (`W-04`) |

**Cases:** `E-READ-01`..`E-READ-05`, `E-STREAM-01`..`E-STREAM-06`, `I-MIRROR-01`, `W-04`.

## G6 — Command across nodes

| Check | Pass condition |
|---|---|
| From a model | `task.ask` returns the peer's answer, stop reason, elapsed time, session id, and usage when the peer reports it (`E-WRITE-03`) |
| Through the shipped peer tools | `peer_ask` against a mesh peer succeeds once `task.ask` is granted, with no change to `packages/peer/tool-peer` (`I-PEERS-02`) |
| Against a real model | the same flow completes end to end with a real model, self-skipping without a key (`I-REAL-01`) |
| Create, cancel, search | a create lands in the requested directory inside the roots; cancel ends the peer's turn and retains the pending inbox; search answers from the peer's own index (`E-WRITE-02`, `E-WRITE-04`, `E-WRITE-05`) |
| A write survives a peer restart | the session resumes and the turn completes (`E-WRITE-06`) |
| Denied by default | a freshly paired peer cannot prompt, create, cancel, or search (`E-WRITE-01`) |
| Confinement is enforced, not advisory | a write grant whose confinement is missing fails the peer's load rather than running (`E-WRITE-07`) |
| Approval is bounded | with `approval: always` a local CLI approval admits the turn, and with no operator the request fails at the approval bound instead of hanging (`E-APPROVE-01`, `E-APPROVE-02`) |
| Loop control | a genuine A to B to A nested tool call is refused with `MESH_HOP_LIMIT`, and a request whose visited set already contains the target is refused before any socket opens (`E-LOOP-01`, `E-LOOP-02`) |
| From the GUI | the remote session view streams, reconnects, and resumes (`W-04`); submitting a task from the mesh panel is exercised by hand, because the inventory has no browser case for that action yet |

**Cases:** `E-WRITE-01`..`E-WRITE-06`, `I-PEERS-02`, `I-REAL-01`, `E-LOOP-01`.

## G7 — Fail loud and consistently

| Check | Pass condition |
|---|---|
| One collapsed code reaches the caller | a missing, unknown, revoked, or expired token all produce `401 MESH_UNAUTHENTICATED`; the caller cannot tell them apart (`E-DENY-01`, `E-DENY-02`, `E-DENY-03`) |
| The distinction lives where it is safe | the serving node's durable audit records which classification the presented `keyId` had, and the operator reads it with `dsh mesh audit`; the difference is deliberately local-only, and no acceptance check claims otherwise |
| Every denial that can be distinct is distinct | an operation outside the grant is `MESH_NOT_ALLOWED`, a `cwd` outside the roots is `MESH_CWD_DENIED`, an unlisted preset is `MESH_PRESET_DENIED`, and a path outside the route table is an empty `404` (`E-DENY-04`..`E-DENY-07`) |
| No failure is a bare 500 | the only 500s are genuine unexpected throws, and the case set asserts none occur (`E-READ-04`, `U-AGENT-03`) |
| A dead network is bounded | `E-NET-01` fails within the request bound with `MESH_UNAVAILABLE`, and a stopped listener is `MESH_UNAVAILABLE` while the node still looks online from Serve (`E-NET-03`) |
| Misconfiguration fails at load | a non-Tailscale bind address, a wildcard grant, and a write grant without confinement each fail the load (`U-AGENT-01`, `U-POLICY-02`, `U-POLICY-11`, `U-GRANT-05`) |
| Invitation outcomes collapse | every non-matching invitation outcome returns `MESH_PAIR_UNKNOWN`, and an expired grant denies while the caller still sees one code (`U-PAIR-06`, `U-POLICY-10`) |

**Cases:** `E-DENY-01`..`E-DENY-07`, `U-PAIR-06`, `U-POLICY-10`, `E-NET-01`.

## G8 — Be inspectable after the fact

| Check | Pass condition |
|---|---|
| Every admitted and denied request is audited | one durable record per case carrying operation, peer, outcome, and duration (`E-OPS-01`, `U-AUDIT-01`) |
| Retention is bounded and rotating | the count bound and the age bound both hold, and pruning keeps the newest records (`U-AUDIT-01`) |
| Records survive a restart | a new process over the same home reads the records written before it (`U-AUDIT-05`) |
| Correlation is keyed | two different keys give different hashes and one key is stable, so a guessed prompt cannot be confirmed (`U-AUDIT-03`) |
| An audit-store failure follows the configured policy | `refuse-writes` refuses the operation and `degrade` counts the drop (`U-AUDIT-04`) |
| No record discloses content | no prompt, path, token, cookie, or code appears in any record (`U-AUDIT-02`) |
| The operator can read it | the audit view pages and filters, and shows a partial-view notice when records were dropped (`W-05`) |

**Cases:** `U-AUDIT-01`..`U-AUDIT-05`, `E-OPS-01`.

## G9 — Be revocable with honest semantics

| Check | Pass condition |
|---|---|
| Revoking on one node stops **that node** accepting the peer | `dsh mesh unpair --node <nodeId>` on the serving node deletes its own grant record and the peer's inbound token hash; the very next request is `401`, with no cached acceptance and no restart (`U-GRANT-02`, `E-DENY-02`, `E-OPS-02`) |
| Revocation cannot make the peer drop its token | the peer keeps its outbound credential until a human removes it there; the runbook says so, and no document claims a remote wipe |
| Remote cleanup is authenticated, idempotent, and best effort | a repeated request is a no-op on the peer, and a peer that is unreachable is reported as not cleaned up rather than retried forever; the response names which state it ended in |
| A running turn is not retroactively aborted | revocation during a turn leaves the turn alone and refuses the next request (`E-GRANT-04`) |
| Grant edits are durable and visible | a grant edit survives a peer restart, and a peer's advertised inbound permissions match what it actually enforces (`E-GRANT-03`, `E-GRANT-05`) |
| Re-pairing works | a fresh invitation pairs again and mints a new key id (`E-OPS-03`) |

**Cases:** `U-GRANT-02`, `E-OPS-02`, `E-OPS-03`, `E-DENY-02`, `E-GRANT-04`.

## G10 — Add no new exposure

| Check | Pass condition |
|---|---|
| The GUI is still loopback | probed from another machine **while the GUI is running there**: the driver confirms a listener on the target port before a refusal counts, so `E-ARCH-01` passes only on a machine where the GUI is actually up, and is skipped where that cannot be established |
| The mesh port answers nothing unauthenticated beyond hello | `/`, `/plugins/*`, and `/api/*` answer an empty `404` from another machine (`E-ARCH-02`, `U-AGENT-04`) |
| The hello document is fixed | only protocol versions, node id, display name, fingerprint, and the caller's paired state (`E-ARCH-03`, `U-AGENT-08`) |
| No Funnel listener covers a mesh port | the doctor's Funnel row is green and `tailscale serve status` names no mesh port; on this machine Funnel is on for `tcp://big.tail652dda.ts.net:22`, which is not a mesh port (`E-ARCH-04`, `U-TS-06`) |
| A proxy-supplied identity never authorizes | a forged advisory identity header is recorded as claimed and changes no authorization outcome (`E-ARCH-05`, `U-AGENT-07`) |
| The listener is opt-in | the shipped composition keeps `enabled: false`, so a default install binds nothing (no case: inspected in the shipped composition, which is why `E-ARCH-02` and `E-ARCH-03` report skipped until a listener is started) |

**Cases:** `E-ARCH-01`..`E-ARCH-05`, `U-AGENT-04`, `U-AGENT-08`.

## Repository-level acceptance

| Check | Command | Pass condition |
|---|---|---|
| Unit and integration | `pnpm run test` | every `U-` and `I-` case present and passing |
| Coverage | `pnpm run test:coverage` | per-file 100% on every new `src` file under `packages/*/*/src` |
| REAL-composition boot | `pnpm run test` | `I-BOOT-01` boots its test-only `cordis.yml` through the real Loader, reaches the service, and unwinds every entry |
| Real-model end-to-end | `pnpm run test:e2e` | `I-REAL-01` passes with `DEEPSEEK_API_KEY`; without a key it self-skips, and the skip is recorded as a skip |
| GUI | `pnpm run test:gui` and `DSH_SNAPSHOT=replay pnpm run test:web` | the settings section, the pairing dialog, the grant editor, the audit view, and the remote-session views pass |
| Snapshots | `pnpm run test:snapshot` | a keyless recorded-session scenario covers the mesh tools' model-visible output |
| Static gates | `pnpm run constraints`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run verify-cordis-config`, `pnpm run verify-client-ui-i18n`, `pnpm run doc-sync`, `pnpm run hygiene` | all green |
| Documentation | `pnpm run test:docs` and `pnpm run website:build` | every package README has its required sections and its pair, the subsystem page exists and is linked, the group page and the generated config catalog are current, the Agent Note records the decision, and no link is dead |
| Cross-machine | `pwsh harness-mesh/assets/mesh-e2e.ps1 -Suite all` | every `E-` case that can run on this tailnet passes, and every case that cannot is reported as skipped with its reason |
| Operational | `pwsh harness-mesh/assets/mesh-doctor.ps1` | `O-03` exits 0 with every row green or explicitly skipped, and `O-04` exits 1 when a row is forced red; `O-01` and `O-02` report once the certificate and socket-path rows land |

## Conditions under which this plan is NOT complete

- Any `E-` case skipped because SSH is unavailable is still skipped. The suite reports it as skipped, and this plan records it as not done; today that is every case behind `E-00`.
- macOS is specified but not exercised. No macOS device is on this tailnet, and that is a stated gap rather than an acceptance.
- `E-ARCH-01` is unproven until it runs against a machine where the GUI is actually listening. A refused connection to a port where nothing is listening establishes nothing, and the driver now reports that situation as skipped; the corrected result is in [the observed run](06-observed-run.md).
- `E-ARCH-02` and `E-ARCH-03` are unproven until the mesh listener is running on a peer node.
- Nothing about the mesh itself is proven today, because none of it exists in the repository.
- The remote-cleanup half of revocation is best effort and has no case in the inventory; the acceptance text states the limit instead of implying a guarantee.
- `O-01` certificate availability and `O-02` port-or-socket availability are specified for the doctor and not implemented in it yet; the [`P0-05` item in the todo](../03-implementation/05-todo.md) owns them.
- The doctor's Funnel row was green by construction at the time of the observed run, because it read `publishedPort` and `meshPort` fields the descriptors did not define. **Fixed**: the doctor and the driver now read `listen` and `published.port`, and the doctor's bind check accepts a unix socket. The row is a real check from this revision onward, and `E-ARCH-04` covered it correctly throughout.
- No `v8 ignore` comment stands in for a covered arm.
- The Funnel-exposure check is observed green on a machine that genuinely runs a Funnel listener, on TCP port 22, which is not a mesh port. The warning path for a Funnel listener **on** a mesh port is exercised by `U-TS-06` and `E-ARCH-04`; observing it fire for real requires a deliberate misconfiguration on a peer.

## Sign-off checklist

- [ ] All ten goal tables pass on a real two-machine tailnet.
- [ ] The timed workflow completed from the state where both nodes are enabled and published, with every untimed precondition met and any recovery exercised by hand.
- [ ] All repository-level gates pass from a clean checkout.
- [ ] `I-REAL-01` passed at least once with a real key, and the run report says whether it ran or skipped.
- [ ] The cross-machine run report lists zero skips other than the macOS row, or lists every skip with its reason.
- [ ] The security runbook's key-handling steps were executed at least once, including a revocation, a best-effort remote cleanup with its outcome recorded, and a re-pair.
- [ ] The Funnel warning was observed firing, not merely implemented.
- [ ] Every code-carrying channel was scanned after the run (`E-PAIR-09`, `E-OPS-05`).
