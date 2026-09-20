---
description: "What the plan's own doctor and network suite actually reported on this machine and this tailnet, including the retraction of an earlier claim that the run proved the GUI-loopback posture."
kind: "validation"
---

# Observed run

The scaffolding in [assets](../assets/00-ASSETS.md) was executed against this machine and this tailnet while the plan was written. This document records what came back, because a validation plan whose own tooling has never been run is a claim rather than a plan.

## Correction: the GUI-loopback result was not proved

An earlier version of this document reported `E-ARCH-01` as a pass and said the run **proved** that neither peer exposes its Web GUI. That claim was wrong and is retracted.

The driver probed the peers' web ports and saw the connections refused, but nothing was listening on those ports: starting the harness is a step the driver never took, and SSH to those machines does not work. A refused connection to a port where no process is listening establishes nothing about the bind address — the port would refuse whether the GUI bound loopback or bound the tailnet. The probe answered a question nobody had asked, and reporting it as a pass turned absence of evidence into a proof.

The driver has since been fixed. Before a refusal counts, it checks the target machine for a listener on that port — locally through `Get-NetTCPConnection`, over SSH through `ss -ltn` — and reports the case as **skipped** when the listener is absent or cannot be determined. The corrected result below is `E-ARCH-04` pass and `E-ARCH-01`, `E-ARCH-02`, and `E-ARCH-03` skipped on both peer nodes, because no harness is running there and no SSH is available.

## `mesh-doctor.ps1` — full run

| Node | Check | Ok | Skipped | Detail |
|---|---|---|---|---|
| W | tailscale-peer | yes | no | `DNSName=big.tail652dda.ts.net. ips=100.122.125.15,fd7a:115c:a1e0::b001:7d8c online=True` |
| W | address-current | yes | no | recorded `100.122.125.15` matches the tailnet |
| W | local-runtime | yes | no | `node v22.19.0` |
| W | mesh-bind-address | yes | no | no listener on the mesh port (the listener is opt-in) |
| L | tailscale-peer | yes | no | `DNSName=kimi.tail652dda.ts.net.`; online; the recorded `100.106.46.112` is present in `TailscaleIPs` |
| L | address-current | yes | no | recorded `100.106.46.112` matches the tailnet |
| L | ssh | **no** | no | `ssh: Could not resolve hostname dsh-linux: No such host is known.` |
| L | remote-runtime | yes | **skipped** | skipped: no ssh access |
| L | mesh-bind-address | yes | **skipped** | skipped: no ssh access |
| X | tailscale-peer | yes | no | `DNSName=tigs-pi.tail652dda.ts.net.`; online; the recorded `100.109.254.34` is present in `TailscaleIPs` |
| X | address-current | yes | no | recorded `100.109.254.34` matches the tailnet |
| X | ssh | **no** | no | `ssh: Could not resolve hostname dsh-attacker: No such host is known.` |
| X | remote-runtime | yes | **skipped** | skipped: no ssh access |
| X | mesh-bind-address | yes | **skipped** | skipped: no ssh access |
| M | device-present | **no** | no | no macOS device is present on tailnet `tail652dda.ts.net` |
| machine | not-funnel-exposed | yes | no | Funnel is on for `tcp://big.tail652dda.ts.net:22`, none of which is a mesh port |

**Findings.**

1. **The tailnet descriptors match reality.** Both Linux descriptors resolve to the addresses recorded in `assets/nodes.json` from `tailscale status --json`, the driver machine is present with its recorded address, and the local runtime `node v22.19.0` satisfies the engine range `^22.19 || >=24`. The address-drift check is a real check and it currently passes.
2. **This machine genuinely runs a Funnel listener, on TCP port 22.** The Funnel summary names `tcp://big.tail652dda.ts.net:22`, and the mesh port in `nodes.json` is 8444 published, so no Funnel listener covers a mesh port. That is exactly the discrimination `E-ARCH-04` depends on, and it is exercised on a machine where the pattern is real rather than hypothetical.
3. **SSH authorization was the blocking precondition at the time of this run**, exactly as the phased plan's P0 said. The failure was DNS for the alias, not the network. The four dependent rows reported **skipped**, not passed. **This is now closed:** see [the re-run](08-rerun-after-ssh.md).
4. **The macOS gap is a red row, not a silent omission.** `nodes.json` marks the descriptor pending with the reason that no macOS device is on the tailnet.

## `mesh-e2e.ps1 -Suite network`

```
run directory: <timestamped>
node range:    ^22.19 || >=24
E-ARCH-04      pass   no Funnel listener covers a mesh port (funnel endpoints: 1)
E-ARCH-01      skip   L : cannot determine whether the GUI is running (no ssh); a closed port would prove nothing
E-ARCH-02      skip   L : the mesh listener is not running; the published endpoint cannot answer anything yet
E-ARCH-03      skip   L : the mesh listener is not running
E-ARCH-01      skip   X : cannot determine whether the GUI is running (no ssh); a closed port would prove nothing
E-ARCH-02      skip   X : the mesh listener is not running; the published endpoint cannot answer anything yet
E-ARCH-03      skip   X : the mesh listener is not running
pass=1 fail=0 skip=6
```

The run directory holds `results.csv`, `tailscale-status.json`, and `tailscale-serve.txt`; run directories are generated artifacts and are not kept in this folder. The doctor runs separately, and the driver's `preflight` suite re-runs it, which is where `E-03` fails while the macOS row and the two SSH rows are red. `-Suite all` additionally reports the five suites that need unimplemented packages as skipped rather than passed.

## What this run does and does not prove

**Established by this run:**

- The `nodes.json` descriptors agree with the live tailnet, and the local runtime satisfies the engine range.
- This machine runs a Funnel listener on TCP port 22, and no Funnel listener covers a mesh port, which is `E-ARCH-04`. The driver reads the published port from each descriptor and compares it against the Funnel summary, so this pass is a real check.
- The skip-versus-pass discipline is implemented in code and it worked: six cases whose precondition is absent were reported as skipped with the reason, and the summary counted them as skips rather than passes.

**Not established by this run:**

- **Nothing about the mesh itself.** None of it exists in the repository, so every `E-PAIR-`, `E-READ-`, `E-STREAM-`, `E-WRITE-`, `E-DENY-`, `E-BUDGET-`, `E-NET-`, `E-LOOP-`, `E-OPS-`, `E-GRANT-`, and `E-APPROVE-` case is unexecuted.
- **The GUI-loopback posture on the peer nodes**, which is the claim the earlier version of this document retracted. `E-ARCH-01` is skipped on both of them until a harness is actually running there and a listener can be confirmed before the probe.
- **Anything answering on the published endpoint**, because no mesh listener is running on either peer; `E-ARCH-02` and `E-ARCH-03` report skipped for that reason.
- **The doctor's Funnel row, as it stood during this run.** At the time, the row read `publishedPort` and `meshPort`, which `assets/nodes.json` did not define, so its mesh-port list was empty and the row could not go red. **This has since been fixed**: the doctor and the driver now both read `listen` and `published.port` from the descriptors, and the doctor's bind check handles a unix socket as well as a TCP port. The Funnel evidence in this document rests on the driver's `E-ARCH-04`, which was correct at the time and remains the case that would catch a real exposure.
- **`O-01` certificate availability and `O-02` port-or-socket availability.** The doctor does not report either yet; the [`P0-05` item in the todo](../03-implementation/05-todo.md) owns adding those rows.
- **Anything macOS-specific.** No macOS device is on the tailnet.

## Reproducing

```powershell
pwsh harness-mesh/assets/mesh-doctor.ps1
pwsh harness-mesh/assets/mesh-e2e.ps1 -Suite network
```

The doctor exits `1` on this environment, because the macOS row and the two SSH rows are red. That is the honest result until the P0 items are closed.
