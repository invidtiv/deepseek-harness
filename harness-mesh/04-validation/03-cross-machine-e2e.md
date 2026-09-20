---
description: "The cross-machine end-to-end suite: topology, SSH orchestration from Windows, provisioning the Linux node, and every E-case with its assertion."
kind: "validation"
---

# Cross-machine end-to-end suite

This tier proves the feature between two real machines on a real tailnet. Every case id below is defined in [the case inventory](07-case-inventory.md); this document owns their method.

## Topology

| Role | Machine | Address | Notes |
|---|---|---|---|
| **Node W** — driver and peer | `big` (this Windows machine) | `big.tail652dda.ts.net`, `100.122.125.15` | Already a `tailscale serve` user, and currently runs a Funnel listener on TCP 22 |
| **Node L** — peer | `bsa-contabo` = `vmi2916953` (Contabo VPS) | `100.115.155.120`, public `212.47.64.174` | **Reachable.** `ssh bsa-contabo` succeeds with the default key: Linux 6.8.0, Node v22.22.2, pnpm 12.4.2. Verified by the doctor, which reports `ssh`, `remote-runtime`, `tailscale-peer`, and `address-current` all green |
| **Node X** — attacker | a **second harness home on W** | `C:/Users/tiaz/.dsh-mesh-x` | No third machine on this tailnet accepts a key — `kimi`, `tigs-pi`, and `ai` reject every user tried. A second home on W is a genuinely different node identity, grant store, and pair of credentials, which is what the unpaired-access and cloned-identity cases actually need. It is not a different operating system, and that is stated rather than implied |
| **Node M** — macOS | none on this tailnet | — | Descriptor present and pending |

Every probe target is derived from [`assets/nodes.json`](../assets/nodes.json): each node carries a `topology`, a `backend` (bind address, port, path), a `published` (scheme, port, path), and a `web` port. The driver reads them; nothing is hardcoded. An earlier revision probed port 3080 on every peer while the descriptors said 3081 and 3082, and probed the raw backend port instead of the published endpoint — both fixed.

`ssh` names an entry in `~/.ssh/config`. That file currently holds a **stale** `kimi` entry pointing at `100.84.218.5`, which `tailscale status` does not list; the preflight reports address drift from `tailscale status --json` so a re-registered node cannot silently point the suite at nothing.

## Preconditions

| Precondition | Current state | Fix |
|---|---|---|
| Passwordless SSH from W to L | **met** — `ssh -o BatchMode=yes bsa-contabo true` exits 0 with the default key | none |
| SSH from L back to W | **not authorized** — `ssh 100.122.125.15` from L is refused | The driver is pull-based by design: W drives L. A push model would need this direction, and the plan does not assume it |
| Node and pnpm on L within the engine range | assumed | The doctor prints what it finds |
| HTTPS certificates for the tailnet, or a decision to run T3 | assumed | Admin console, or set `topology: direct` in the descriptor and the composition |
| A unix socket path the user can create (T1) | unverified | `XDG_RUNTIME_DIR` or `$DSH_HOME/run/mesh.sock` |
| A macOS device | **absent from this tailnet** | None available; the descriptor stays pending |

A case whose precondition is absent is reported as **skipped with the reason** and is never reported as passed. This rule exists because an earlier revision counted a refused connection to a port where nothing was listening as proof that the GUI binds loopback.

## Orchestration

Node W is the only driver. Every remote action is one `ssh` or one `scp`, and the remote harness runs detached with its output captured to a file the driver can read.

### The doctor

`assets/mesh-doctor.ps1` runs first and answers per node: is it in `tailscale status`; does the recorded address still match; is the runtime new enough; is the mesh bound only to a socket, loopback, or a Tailscale address; and, once per machine, is any mesh port Funnel-exposed. Each row carries a remediation line, and a row that cannot be evaluated reports **skipped**, not passed.

**`O-01`** certificate availability, **`O-02`** port or socket availability, **`O-03`** the doctor exits 0 with every row green or explicitly skipped, **`O-04`** the doctor exits 1 when a row is forced red.

### Provisioning node L

`assets/provision-linux.sh` keeps a **bare mirror** at `$HOME/dsh-mesh-mirror.git` and materializes each commit as its own **git worktree** under `$HOME/dsh-mesh-clones/<sha>`. It never checks out inside an existing working tree, and it refuses to run if the worktree is dirty, so the suite always tests committed code. An earlier revision ran `git fetch` and `git checkout <sha>` inside whatever checkout it found, which could discard a user's work.

The driver invokes it as `ssh bsa-contabo 'bash -s' < provision-linux.sh <sha>`, so the script is versioned with the plan, and re-provisioning the same commit is a no-op.

Cold provisioning (clone, install, full build) dominates the suite's cost; the driver caches on the commit and skips it when `.provisioned` already holds the SHA.

### Starting the harness

Both nodes start the web profile through the **installed launcher**, never by reaching into a package build output:

```bash
DSH_HOME="$HOME_DIR" dsh --profile web --no-open --port "$WEB_PORT" &
```

An earlier revision ran `node apps/cli/lib/bin.js --profile web ...`, which is not a supported launch path and bypasses the launcher's profile resolution and shutdown handling. In-repo development uses `pnpm dsh --profile web`; the suite uses `dsh`.

Note what is **not** passed: `--host`. The GUI stays on `127.0.0.1`, and that is the property the design protects.

### Publishing the mesh endpoint

```bash
# T1, the default: serve fronts a unix socket, so there is no local TCP port to spoof.
tailscale serve --bg --https=8444 unix:/run/user/1000/dsh-mesh.sock

# T2: serve fronts a loopback TCP port.
tailscale serve --bg --https=8444 http://127.0.0.1:8737

# 8444, not 8443: the reference machine already publishes 8443 to 127.0.0.1:8765.

# T3: nothing is published; the mesh binds this node's Tailscale address and peers dial it directly.
```

## The cases

Method notes apply to every case: probes use the descriptor's own scheme, host, port, and path; a case that needs a running listener asks the node first and skips when it is absent; and every pairing command reads the code from **stdin**, never from an argument.

### Preflight

| Id | Method | Assertion |
|---|---|---|
| `E-00` | `ssh -o BatchMode=yes bsa-contabo true` | exits 0 within 6 s, no prompt — **verified** |
| `E-01` | `ssh ... 'node --version; pnpm --version'` | satisfies `^22.19 || >=24`, parsed as a range rather than pattern-matched |
| `E-02` | run `provision-linux.sh` | exits 0, the worktree is at the requested commit, and `git status --porcelain` is empty |
| `E-03` | poll each descriptor's `web.port` | the GUI binds within 30 s |
| `E-04` | `GET <publishedBase>/hello` from each side | 200 with the expected node id |
| `E-05` | `tailscale serve status` on both | one mapping per node, tailnet-only, and no Funnel entry for a mesh port |

### Pairing

| Id | Method | Assertion |
|---|---|---|
| `E-PAIR-01` | L invites, W pairs by piping the code to stdin, L approves | both sides list the peer as paired, fingerprints match, and both report the same SAS |
| `E-PAIR-02` | W pairs with one symbol changed | fails with `MESH_PAIR_CONFIRM_FAILED`; L's invitation is **burned**; a second attempt with the correct code also fails |
| `E-PAIR-03` | replay the confirm body from `E-PAIR-01` | one collapsed `MESH_PAIR_UNKNOWN`; the stored pairing is unchanged |
| `E-PAIR-04` | a 5 s TTL, paired after 6 s | `MESH_PAIR_UNKNOWN` — expiry is not distinguished to the caller |
| `E-PAIR-05` | five wrong attempts | the fifth is refused and the invitation burns |
| `E-PAIR-06` | L denies | W receives `MESH_PAIR_DENIED`; no partial record on either side |
| `E-PAIR-07` | approval never happens | W receives `MESH_PAIR_APPROVAL_TIMEOUT` within the bound |
| `E-PAIR-08` | W claims an invitation, then X confirms it | X is refused; the invitation burns; W cannot complete |
| `E-PAIR-09` | a recording loopback proxy between W and L's published endpoint | no code appears in any recorded byte |
| `E-PAIR-10` | copy W's `mesh/identity` into L's credentials, then pair | `MESH_IDENTITY_CONFLICT`; neither side stores a peer equal to itself |
| `E-PAIR-11` | **run the exact command line L printed** | it parses, prompts, and completes — a printed command that does not work is a documentation defect |
| `E-PAIR-12` | drop the `ack` after W receives `sealedB` | W retries within the delivery window, B commits, and both sides end paired |

`E-PAIR-11` is the case that would have caught the earlier draft's printed command, which omitted the `pairingId` and could not have been executed at all.

### Presence and awareness

| Id | Method | Assertion |
|---|---|---|
| `E-PRES-01` | pair, wait one interval | the peer is online within the interval plus jitter |
| `E-PRES-02` | stop the peer harness | offline within the failure threshold, with a last-**successful**-contact age |
| `E-PRES-03` | restart the peer | online again without re-pairing |
| `E-PRES-04` | record a wrong address | falls back to another recorded address, or reports a named error, never a silent hang |

### Reads and streaming

| Id | Method | Assertion |
|---|---|---|
| `E-READ-01` | list | sessions with titles and activity times |
| `E-READ-02` | page one session | matches the peer's own API for the same cursor |
| `E-READ-03` | transcript | reduced messages, oldest first, bounded per message |
| `E-READ-04` | an unknown session id | a named error, never a 500 |
| `E-READ-05` | a session over 500 KB | bounded, marked, and returned in bounded time |
| `E-STREAM-01` | start a turn on L, follow from W | **intermediate** events arrive while the turn is still running, not only the final message |
| `E-STREAM-02` | a turn exceeding the byte cap | the stream closes at the cap with a distinguishable reason |
| `E-STREAM-03` | a queued job longer than the time cap | the stream closes at the cap; L's turn continues |
| `E-STREAM-04` | drop the socket mid-turn, resume from the cursor | no gap and no duplicate |
| `E-STREAM-05` | upgrade with no token | refused, with no half-open socket |
| `E-STREAM-06` | prompt an existing remote session | the turn runs there and the transcript is continuous across the two nodes |

### Writes, grants, budgets

| Id | Method | Assertion |
|---|---|---|
| `E-WRITE-01` | prompt a freshly paired peer | `MESH_NOT_ALLOWED` |
| `E-WRITE-02` | create inside the roots | created on L in the requested directory |
| `E-WRITE-03` | `task.ask` | the answer, stop reason, elapsed, session id, and usage |
| `E-WRITE-04` | cancel a running turn | the turn ends and the pending inbox is retained |
| `E-WRITE-05` | search | results from L's index, not W's |
| `E-WRITE-06` | restart L, then prompt | resumes and completes |
| `E-WRITE-07` | grant a write with no `confinement` | L's composition **fails to load**, naming the missing preset |
| `E-GRANT-01` | narrow a grant | the next request is refused |
| `E-GRANT-02` | edit a grant while a request is in flight | the admitted request is unaffected |
| `E-GRANT-03` | compare advertised inbound permissions with what L enforces | they agree |
| `E-GRANT-04` | revoke during a running turn | the turn is not aborted; the next request is refused |
| `E-GRANT-05` | restart L | the grant edit survives |
| `E-BUDGET-01` | exactly the prompt cap, then one byte more | 200, then 413 |
| `E-BUDGET-02` | two simultaneous asks at a concurrency of one | the second is `MESH_BUSY`; the first completes |
| `E-BUDGET-03` | an hourly cap of two | the third is refused |

### Denials

| Id | Method | Assertion |
|---|---|---|
| `E-DENY-01` | X calls the list operation with no token | **one collapsed 401**; no session data |
| `E-DENY-02` | revoke on L, then call from W | the very next request fails; no cached acceptance |
| `E-DENY-03` | an expired grant | the same **collapsed** code, not a distinct expiry code |
| `E-DENY-04` | create with `/etc` | `MESH_CWD_DENIED` |
| `E-DENY-05` | create with an unlisted preset | `MESH_PRESET_DENIED` |
| `E-DENY-06` | an operation outside the set | 404 |
| `E-DENY-07` | a traversal path | 404 |

`E-DENY-01` and `E-DENY-03` assert **sameness**, not difference: the caller must not be able to tell missing from revoked from expired. The distinction is asserted separately by reading L's durable audit, which is the only place it exists.

### Loop and network

| Id | Method | Assertion |
|---|---|---|
| `E-LOOP-01` | pair W and L, then ask L to ask W | the nested request is refused with `MESH_HOP_LIMIT` — this is a genuine A to B to A tool call, which is why the call chain is session state rather than an HTTP header |
| `E-LOOP-02` | a request whose visited set already contains the target | refused before any socket opens |
| `E-NET-01` | `ssh bsa-contabo 'tailscale down'`, then restore | a named error within the bound, no hang; restoring brings the peer back |
| `E-NET-02` | `tailscale up` | returns to online and the next request succeeds |
| `E-NET-03` | stop only the harness | `MESH_UNAVAILABLE` while the node still shows online from Serve |
| `E-NET-04` | offset L's clock by 10 minutes on a VM host | verification and presence ages stay correct; on bare metal the case is **skipped** with that reason |
| `E-NET-05` | force a relayed path | operations still complete, reporting higher latency |

### Architecture invariants

| Id | Method | Assertion |
|---|---|---|
| `E-ARCH-01` | ask L whether its GUI is listening, **then** probe from W | if the GUI is not running, the case is **skipped**; if it is running, the probe must be refused |
| `E-ARCH-02` | fetch `/`, `/plugins/x`, `/api/session/list` on the **published** endpoint | each 404 |
| `E-ARCH-03` | fetch the anonymous hello | exactly the documented fields, nothing else |
| `E-ARCH-04` | check `tailscale serve status` for Funnel entries covering a mesh port | none |
| `E-ARCH-05` | connect directly to the backend with a forged identity header and a valid token | the outcome is identical to the same request without the header; with **no** token it is still the collapsed 401 |

`E-ARCH-05` is the case that keeps the advisory-identity rule honest. Under T1 there is no local TCP port to make this connection, so the case only applies to T2, and the driver skips it under T1 with that reason.

### Operations

| Id | Method | Assertion |
|---|---|---|
| `E-OPS-01` | restart both harnesses | pairing, grants, and audit survive; presence recovers |
| `E-OPS-02` | revoke on W | W stops accepting L on the next request; L's cleanup is reported as best effort |
| `E-OPS-03` | pair again | succeeds, with a new key id |
| `E-OPS-04` | advertise only a future protocol on L | `426` naming both versions |
| `E-OPS-05` | scan both nodes' logs and durable audit after the whole run | no code appears |
| `E-OPS-06` | execute every command line printed by the runbooks and the invitation output | each parses and runs |

## Running it

```powershell
pwsh harness-mesh/assets/mesh-e2e.ps1 -Suite all
pwsh harness-mesh/assets/mesh-e2e.ps1 -Suite pairing
pwsh harness-mesh/assets/mesh-e2e.ps1 -Suite all -Case 'E-ARCH-*'
```

The driver runs the doctor and aborts on a red row, provisions L for the current commit if needed, starts both harnesses, publishes both endpoints, runs each case in its own try/finally, collects artifacts into `assets/runs/<timestamp>/` (`results.csv`, both logs, both audit exports, both `tailscale status --json` dumps, and the `E-PAIR-09` capture), and tears down.

**What it does not do yet.** Provisioning, process control, artifact collection, and teardown are specified here but not implemented; the driver currently runs the `preflight` and `network` suites and reports every other suite as skipped with a reason. `-KeepRunning` warns that it has no effect. That is stated in [the assets guide](../assets/00-ASSETS.md) rather than implied.

## Cost

| Phase | Warm | Cold |
|---|---|---|
| Doctor | seconds | seconds, failing fast |
| Provision | skipped | 10 to 25 minutes for install and build |
| Start both | under a minute | under a minute |
| Cases | 4 to 8 minutes | 4 to 8 minutes |
| Teardown | seconds | seconds |

Not part of the per-commit gate. It runs on demand, before a release, and for the phases whose exit gates name `E-` cases.
