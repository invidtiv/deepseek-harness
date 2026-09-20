---
description: "The edge-case matrix: network, identity, pairing, protocol, session, concurrency, loop, security, platform, and operational edge cases, with the case that covers each."
kind: "validation"
---

# Edge cases

Each row states the scenario, why it matters, what the system must do, and which [inventory](07-case-inventory.md) case covers it. **Design** means the row is a decision the implementation must honour even though no single test proves it.

## Network and Tailscale

| # | Scenario | Why it matters | Required behaviour | Covered by |
|---|---|---|---|---|
| N1 | Tailscale is down on one node | The common failure; must not hang | Named `MESH_UNAVAILABLE` within the request bound; presence flips to offline | `E-NET-01` |
| N2 | Tailscale up, listener stopped | Distinguishes "machine down" from "harness down" | `503` while the node still shows online from Serve | `E-NET-03` |
| N3 | A relayed path instead of a direct connection | Latency changes by an order of magnitude; timeouts must not be tuned to direct | Operations complete; latency is reported; no low fixed timeout | `E-NET-05` |
| N4 | A MagicDNS rename | Stored endpoints go stale | Fall back to a stored address and re-resolve on the next presence cycle | `E-PRES-04` |
| N5 | A node re-registers with a new address | Exactly the state this machine's `~/.ssh/config` is in today — a stale `kimi` entry at `100.84.218.5` against a live `100.106.46.112` | The doctor flags drift; the mesh prefers the name and re-resolves | `O-03` |
| N6 | IPv6-only addressing | Tailscale hands out `fd7a:115c:a1e0::/48`; URLs need bracketing | Bracket the host in every URL | `U-TS-02` |
| N7 | Both address families present | Ordering must be deterministic | IPv4 first, as `TailscaleIPs` reports it | `U-TS-02` |
| N8 | An OS-assigned port | A node may publish port 0 and learn the real one after bind | Advertise the bound value, never the requested one | `U-AGENT-01` |
| N9 | The port or socket path is already taken | A confusing silent failure otherwise | `MESH_PORT_IN_USE` naming the conflict, at load | `U-AGENT-02` |
| N10 | Windows Firewall | Relevant only to topology T3 | The doctor probes reachability, not just the listener | `O-03` |
| N11 | A second tailnet or an exit node changes routing | Traffic may take an unexpected path | Nothing in the protocol depends on direct connectivity | `E-NET-05` |
| N12 | A pairing attempt from off-tailnet | Under T3 the source address is authentic and can be checked; under T1 and T2 it is the local proxy and cannot | Under T3, refuse a non-tailnet source before any cryptographic work. Under T1 and T2 the controls are the global rate limit, the per-invitation attempt cap, and human approval | `E-DENY-01`, `U-PAIR-10` |
| N13 | `tailscale serve` restarts | The proxy drops connections | Treat as a transient network failure with backoff, not a pairing loss | `U-RETRY-01` |
| N14 | Funnel covers the mesh port | Publishes a control plane to the public internet **and strips identity headers** | Detected at startup, warned prominently, doctor row red, runbook carries the off command | `E-ARCH-04`, `U-TS-06` |
| N15 | A local process connects straight to the backend under T2 and forges identity headers | Tailscale documents this and offers no mitigation beyond binding to localhost | Authorization is unaffected because it never reads those headers; the forged value is recorded as *claimed* | `E-ARCH-05`, `U-AGENT-07` |
| N16 | Under T1 there is no local TCP port at all | The spoofing path of N15 does not exist | A unix socket target is the default; loopback TCP is documented as the weaker option | `U-AGENT-01` |

## Identity

| # | Scenario | Why it matters | Required behaviour | Covered by |
|---|---|---|---|---|
| I1 | `$DSH_HOME` copied to a second machine | Coarse clone; both nodes claim one identity | `MESH_IDENTITY_CONFLICT`; self-pairing refused | `E-PAIR-10` |
| I2 | The identity record is deleted | The node becomes a stranger to its peers | Peers report the old fingerprint; a clear "pair again" path; never a silent trust of a new identity | `U-IDENT-03` |
| I3 | Two harnesses on one machine with different homes | Legitimate and common | Distinct node ids and distinct ports | `U-IDENT-02` |
| I4 | Two harnesses on one machine with the same home | The shipped default already shares the session list | Sessions are shared locally; the mesh refuses a second listener on the same socket or port and names the holder | `U-AGENT-02` |
| I5 | A display name with emoji, RTL text, or a newline | Rendered in another node's UI | Render as inert text; never interpolate into a command line or a log format string | `W-01` |
| I6 | A peer's fingerprint changes after pairing | Either a rebuild or an impersonation | Refuse with `MESH_IDENTITY_CONFLICT` and require an explicit re-pair | `U-IDENT-03` |
| I7 | A clone runs while the original is live | The only detectable case | Divergence on a signed challenge raises `MESH_IDENTITY_CONFLICT` | `E-PAIR-10` |
| I8 | A clone runs while the original does not | **Undetectable by possession alone** | Documented residual risk; the runbook prescribes deleting `mesh/identity` when a home is copied | Design |

## Pairing

| # | Scenario | Why it matters | Required behaviour | Covered by |
|---|---|---|---|---|
| P1 | The correct code against the wrong invitation | Two invitations open at once | The code is bound to its `pairingId`; a code from another invitation fails | `U-PAIR-01` |
| P2 | Two initiators race on one invitation | The second must not hijack the first | The invitation is claimed by whichever arrives first; the second is refused **on the cryptographic path**, and the invitation burns. Source-address pinning is an additional control only under T3 | `E-PAIR-08` |
| P3 | The initiator restarts mid-handshake | Its ephemeral state is in memory | Nothing is written anywhere; the human creates a fresh invitation | Design |
| P4 | The responder restarts mid-handshake | Invitations are in memory | A fresh invitation is required, and the UI says so rather than showing a stale countdown | Design |
| P5 | Clock skew between nodes | TTL and the delivery window are wall-clock | TTL is measured by the node that owns the invitation; the initiator's poll bound is independent and generous | `U-PAIR-02`, `E-NET-04` |
| P6 | A homoglyph in the code | `O` against `0`, `l` against `1` | Crockford folding; the alphabet excludes `I`, `L`, `O`, `U` | `U-CRYPTO-02` |
| P7 | The code pasted with whitespace or a dash | The common paste path | Normalized, not rejected | `U-CRYPTO-01` |
| P8 | A trailing non-breaking space | Pasted from a chat client | Normalized as whitespace | `U-CRYPTO-01` |
| P9 | Approval arrives after the TTL | A human was slow | `MESH_PAIR_UNKNOWN` to the caller, expired in the local audit; no partial pairing | `E-PAIR-04` |
| P10 | Approve clicked twice | Double submission | Idempotent; the second approve is a no-op | `U-PAIR-01` |
| P11 | Both sides pair with each other simultaneously | Two independent invitations | Two independent key ids; the second pairing supersedes the first with an audit note | Design |
| P12 | The code leaks and the attacker reaches the endpoint in time | The residual risk of any short-code scheme | Under T1 and T2 the attacker's only extra hurdle is the human approval, which shows a claimed identity and a SAS; under T3 the source is additionally pinned. The per-invitation attempt cap bounds the whole attack to five tries | `E-PAIR-02`, `E-PAIR-08` |
| P13 | An active relay | The reason the handshake is a PAKE | Confirmation tags fail on both legs and the responder burns the invitation on the first bad `cA` | `U-CRYPTO-12`, `E-PAIR-02` |
| P14 | A recorded transcript is attacked offline | The defect the review caught in the earlier design | **No offline verifier exists**: SPAKE2 gives nothing checkable without an ephemeral secret | `U-CRYPTO-06`, `U-CRYPTO-12` |
| P15 | The sealed payload is truncated in transit | Wire corruption | GCM tag verification fails; the invitation burns | `U-CRYPTO-10` |
| P16 | The responder crashes after staging but before approval | A staged record and an invitation are in memory | Both are lost; the initiator's poll gets the collapsed unknown response and reports a named failure; the human re-invites | Design |
| P17 | The initiator crashes after committing its outbound record, before the ack | A is paired, B is staged | A retries the ack on its next presence cycle inside the delivery window and B commits | `E-PAIR-12` |
| P18 | The acknowledgment is lost in transit | Ordinary packet loss | The response is redelivered identically on every poll until acknowledged, within the delivery window | `E-PAIR-12` |
| P19 | The delivery window closes with no ack | A half-pairing would otherwise persist | The staged record is deleted and both sides report `MESH_PAIR_INCOMPLETE` | `U-PAIR-12` |
| P20 | The initiator cannot verify `cB` | A wrong code or a relay | It calls `pair/abort` with its staged token; the responder deletes the record and burns the invitation | `U-CRYPTO-12` |
| P21 | The initiator's credential write fails after receiving `sealedB` | Partial local state | It calls `pair/abort`; if that also fails, the responder's staged record expires on its own window | Design |

## Protocol and versioning

| # | Scenario | Why it matters | Required behaviour | Covered by |
|---|---|---|---|---|
| V1 | A peer speaks only a future protocol | Rolling upgrade | `426` naming both versions; never a lenient parse | `E-OPS-04` |
| V2 | A peer speaks an older protocol | Rolling upgrade the other way | The older version stays advertised for one release; a downgrade is explicit | Design |
| V3 | A stored record has an unknown version | A downgrade after an upgrade | Refused with a named error; never parsed leniently | `U-GRANT-03` |
| V4 | A malformed JSON body | Hostile or broken client | `400` with a named code; never a stack trace or a 500 | `U-AGENT-03` |
| V5 | Unknown fields in an otherwise valid body | Forward compatibility | **Rejected**, not ignored: a peer sending an unknown field is running a different protocol, and dropping it would hide that | `U-AGENT-06` |
| V6 | A fractional or out-of-range count | Silent coercion would change behaviour | Rejected by the schema before authorization sees it | `U-AGENT-06` |
| V7 | An operation added on one side only | Independent deployment | `404`; the caller reports the operation name | `E-DENY-06` |
| V8 | A response envelope that does not match the request | The peer transport's own discipline | Refused as `MESH_PROTOCOL_MALFORMED` | `U-AGENT-03` |
| V9 | A response larger than the bound | A peer could otherwise exhaust the caller | Truncated with a marker, and the complete encoded value is within the bound | `U-BOUND-06`, `U-BOUND-07` |
| V10 | A version mismatch on an unknown invitation | The earlier draft returned both `426` and a collapsed `404` for this | The protocol field is checked **before** the invitation and is not secret, so `426` is correct there; everything about the invitation collapses to one response | `U-PAIR-06` |

## Session semantics

| # | Scenario | Why it matters | Required behaviour | Covered by |
|---|---|---|---|---|
| S1 | Two writers on one session | The storage lease already forbids it | Never attempted: the mesh always writes through the owner | Design |
| S2 | A remote turn while a local operator drives the same session | Common | `session/writer-held` and `session/agent-busy` surface as named errors | `E-WRITE-06` |
| S3 | A session id collision across nodes | Both are minted as `session-` plus a UUID | Every cross-node reference is namespaced by node id | Design |
| S4 | Different session format generations | v2 and v3 logs coexist in one store on this machine | The mesh never reads a session file; it reads the owner's API | Design |
| S5 | A remote session is deleted on its owner | A followed view loses its subject | The stream ends with a named reason; the view reports it rather than hanging | `E-STREAM-04` |
| S6 | A very large remote session | 887 KB logs exist on this machine | Bounded reads and streams with explicit markers | `E-READ-05`, `E-STREAM-02` |
| S7 | A mirrored event would enter the local log | Two harnesses, one log, wrong authorship | Forbidden; a mirror is a separate view, and a case scans the local store | `I-MIRROR-01` |
| S8 | A peer's session title contains markup | Rendered in another node's UI | Rendered as text, never as markup | `W-01` |
| S9 | An attachment or image in a peer transcript | The shipped peer tools forward text only | Dropped with a placeholder count; widening is a separate decision | Design |
| S10 | A cold session on the peer | Reading must not resume an agent | Reads use the list and page paths, which do not resume | `E-READ-02` |
| S11 | A prompt against an existing remote session | It names no `cwd`, so a `cwd` allowlist says nothing about it | Authorized against the session's **own recorded metadata** | `U-POLICY-13`, `E-STREAM-06` |

## Concurrency and lifecycle

| # | Scenario | Why it matters | Required behaviour | Covered by |
|---|---|---|---|---|
| C1 | Two asks at a concurrency of one | Cost and blast-radius control | The second is `MESH_BUSY`; the first completes | `E-BUDGET-02` |
| C2 | The plugin is unloaded mid-request | HMR is always on | The request aborts with a named error, the socket closes, the port is released | `U-HMR-02` |
| C3 | The plugin is unloaded mid-pairing | Same, for the pairing plane | Invitations are destroyed; the initiator sees a named failure, not a hang | `U-HMR-01` |
| C4 | A reconnect storm after a blip | Every peer retries at once | Jittered backoff with a ceiling | `U-RETRY-01` |
| C5 | Presence probes overlap a slow request | Naive timers pile up | Presence is single-flight per peer | `U-AGENT-05` |
| C6 | Two harness processes under one `$DSH_HOME` | The shared session store makes this real | Credential writes serialized by `modifyRecord`; the listener conflict is reported | `U-IDENT-04` |
| C7 | A request outlives its grant's expiry | A long turn started under a valid grant | The grant is checked at admission; a running turn is not killed, and the audit records both facts | `E-GRANT-04` |
| C8 | Revocation during a running turn | The operator pulls the plug | Running work is not aborted; no new request is admitted | `E-GRANT-04` |
| C9 | A grant edit lands while a request is in flight | A spec must not change under an executor | The frozen specification is unaffected | `E-GRANT-02` |
| C10 | The audit store is unavailable | An unlogged remote turn is worse than a refused one | The configured policy applies: `refuse-writes` refuses, `degrade` counts drops and reports health | `U-AUDIT-04` |

## Loops, recursion, cost

| # | Scenario | Why it matters | Required behaviour | Covered by |
|---|---|---|---|---|
| L1 | Two nodes ask each other | The most likely accidental loop | Hop counter plus a visited set; refused before a socket opens | `E-LOOP-01`, `U-LOOP-01` |
| L2 | A three-node cycle | Harder to see by inspection | The visited set travels in the request and is checked by every node | `U-LOOP-01` |
| L3 | A node asks itself | Trivial to type by accident | Refused by node id before any network call | `U-LOOP-01` |
| L4 | A retry duplicates a turn | Cost and duplicate work | `Idempotency-Key` on every write | `U-IDEM-01` |
| L5 | A model loops `mesh_command` | Unbounded spend | The hourly budget on the serving node plus the caller's own tool guards | `E-BUDGET-03` |
| L6 | **The loop guard must survive a model turn** | HTTP headers vanish once B's model runs, which is exactly the A to B to A case | The call chain is a session event plus a projection; an outbound command inherits `hops + 1` and the visited set from the current session | `U-ORIGIN-01`, `U-ORIGIN-02`, `E-LOOP-01` |

## Security and privacy

| # | Scenario | Why it matters | Required behaviour | Covered by |
|---|---|---|---|---|
| X1 | An unpaired tailnet neighbour probes the port | The tailnet holds tagged devices outside this user's control | Only the hello is anonymous, and it returns a fixed minimal document | `E-DENY-01`, `E-ARCH-03` |
| X2 | A token leaks into a log | Logs are shipped and read | No token, cookie, or code in any log, audit record, event, or error message | `U-SELF-05`, `E-OPS-05` |
| X3 | A code leaks into a log or a command line | Same, with an extra channel | The code is never accepted from argv or a tool call, and never written anywhere | `U-PAIR-11`, `U-CLI-02`, `E-OPS-05` |
| X4 | The grants store is stolen | It lives beside other credentials | It holds only hashes; nothing usable against the serving node | `U-GRANT-01` |
| X5 | The outbound credential file is stolen | Unavoidable for a bearer token | Revocation is one command and `lastUsedAt` makes misuse visible | `E-DENY-02` |
| X6 | A remote `cwd` names a symlink out of the allowed root | The allowlist is a control on the named directory | Paths are resolved before comparison; an escaping symlink is denied | `U-POLICY-05` |
| X7 | A remote request names a device path or a UNC path | Platform-specific | Non-absolute and device-shaped paths are denied by validation | `U-POLICY-07` |
| X8 | A peer sends an enormous body | Memory exhaustion | `413` before allocation, checked against the declared length and the streamed bytes | `U-AGENT-03`, `E-BUDGET-01` |
| X9 | A peer sends many small requests | CPU exhaustion | Global and per-invitation rate limits on pairing; budgets on operations | `U-PAIR-10`, `E-BUDGET-03` |
| X10 | A peer's display name impersonates another node | Social engineering at approval time | The dialog shows the verified fingerprint and the SAS, and labels proxy identity as claimed | `W-02` |
| X11 | The loopback self-session is used by a local attacker | Local unprivileged access | The mesh port still requires a token, and the self-session is never re-exposed | `U-SELF-05` |
| X12 | A request is replayed | Bearer tokens do not prevent replay by a holder | Idempotency keys make it harmless for writes; the audit makes it visible. Documented, not defended | `U-IDEM-01` |
| X13 | A forged proxy identity header | Any local process can send one under T2 and T1 is deliberately socket-only | Never an authorization input; recorded as *claimed*; a forged header changes no outcome | `E-ARCH-05`, `U-AGENT-07` |
| X14 | An unauthorized caller tries to tell apart missing, revoked, and expired | A failure oracle | One collapsed `MESH_UNAUTHENTICATED`; the distinction exists only in the serving node's durable audit, keyed by the presented `keyId` | `E-DENY-01`, `E-DENY-03` |
| X15 | The audit log itself is read by an attacker | Plain hashes would let them confirm a guessed prompt | Correlation hashes are HMAC under a local credential-held key | `U-AUDIT-03` |
| X16 | A write is granted without a confining preset | Remote code execution | The composition fails to load; at request time `MESH_CONFINEMENT_REQUIRED` | `U-GRANT-05`, `E-WRITE-07` |

## Platform

| # | Scenario | Why it matters | Required behaviour | Covered by |
|---|---|---|---|---|
| F1 | A Windows node | This machine | Wire paths are always POSIX; local paths use the host separator | `U-POLICY-07` |
| F2 | A Linux node | The tested peer | Standard | `E-*` |
| F3 | A macOS node | Required by the request, absent from this tailnet | Specified from source; no end-to-end coverage until a Mac joins | Design |
| F4 | `$DSH_HOME` differs per platform | `C:/Users/tiaz/.dsh` here, `~/.dsh` on Linux and macOS | Never assume a path; resolve through the home-paths helper | Design |
| F5 | Case-insensitive filesystems | macOS and Windows | Containment follows the host filesystem; the wire assumes neither | `U-POLICY-08` |
| F6 | A node's clock is not UTC | Timestamps on the wire | Epoch milliseconds throughout; formatting is the UI's business | Design |
| F7 | Non-ASCII in names, titles, and paths | Real users | UTF-8 throughout; byte bounds counted in bytes | `U-BOUND-02` |
| F8 | Windows named pipe and macOS socket-path differences for LocalAPI | Only relevant to optional corroboration | The design never depends on LocalAPI; where it is used it is optional and permission-gated | Design |

## Operational

| # | Scenario | Why it matters | Required behaviour | Covered by |
|---|---|---|---|---|
| O1 | A harness restart | Daily | Pairing, grants, audit, and sessions survive; presence recovers | `E-OPS-01` |
| O2 | A machine is reimaged | The identity is gone | Peers report a fingerprint mismatch and require an explicit re-pair | `U-IDENT-03` |
| O3 | An operator unpairs by mistake | Recoverable | Re-pairing with a fresh invitation works and mints a new key id | `E-OPS-03` |
| O4 | Two people pair at once on one node | The invitation cap and the approval list | Both appear with their own SAS; approving one does not affect the other | `U-PAIR-08` |
| O5 | A peer is decommissioned without unpairing | Common | Presence flips to offline and stays; removal is one action; nothing retries forever | `E-PRES-02` |
| O6 | A node's Tailscale key expires | MagicDNS and routing stop | An ordinary unreachable peer, with a doctor remediation line | `O-03` |
| O7 | Certificate renewal fails | Serve starts failing | Reported by the doctor; the mesh holds no certificate of its own except a unix socket path | `O-01` |
| O8 | Disk full during a credential write | Rare and corrupting | The failure is loud and leaves no partial record | `U-PAIR-12` |
| O9 | The audit reaches its retention bound | Bounded by design | The oldest records are pruned; a dropped count is surfaced so the UI can say the view is partial | `U-AUDIT-01`, `W-05` |
| O10 | A paired node whose grant denies everything | A deliberate lockdown | Reads also denied; the node still shows paired and online with an empty allowed set | `E-GRANT-01` |
| O11 | A runbook command line does not parse | Documentation rot | Every printed command is executed during the documentation pass | `E-OPS-06` |

## The four cases that would be easiest to get wrong

1. **S7 and L6.** The tempting implementations of "share sessions" and "stop loops" are to append peer events into a local session and to carry hop counts in HTTP headers. Both look right in a single-process test and both fail in the real topology: the first produces a log that cannot be replayed, and the second loses its state the moment the peer's model runs.
2. **X13 and X14.** Presenting a proxy identity as verified, or telling an unauthenticated caller whether a token is missing, revoked, or expired, are the two mistakes that quietly turn a sound design into a vulnerable one. Both are asserted as **sameness** or as **non-influence**, not as a code value.
3. **P14.** The offline verifier is invisible in every functional test: the wrong code still fails, the right code still works, and the relay still fails. Only a design review or a vector-level test catches it. It is the reason the handshake is a PAKE.
4. **N14.** This machine really does run a Funnel listener. A copy-pasted runbook would expose a control plane to the public internet.
