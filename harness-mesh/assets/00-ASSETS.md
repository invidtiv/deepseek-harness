# Assets

Runnable scaffolding for the plan. These are the only executable artifacts in this folder; the plans themselves are documents.

| File | What it is | Runs today? |
|---|---|---|
| [nodes.json](nodes.json) | Node descriptors. Every probe target — scheme, host, backend port, published port, path, topology — is derived from these fields, never hardcoded | yes, as data |
| [mesh-doctor.ps1](mesh-doctor.ps1) | The preflight doctor: tailnet membership, address drift, runtime version, mesh bind address, and Funnel exposure, each with a remediation line and an explicit **skipped** state | **yes** |
| [provision-linux.sh](provision-linux.sh) | Prepares the Linux node from a **dedicated bare mirror plus a per-commit git worktree**, so an existing checkout, its branch, and its uncommitted changes are never touched. Refuses a dirty worktree | yes, once SSH works |
| [mesh-e2e.ps1](mesh-e2e.ps1) | The suite driver: selects suites and cases, runs the doctor, executes the cases that need no mesh code, and writes a run directory with artifacts | **partially** — see the honesty note below |
| [verify-case-inventory.ps1](verify-case-inventory.ps1) | Scans the plan folder for case-id tokens and fails on any id the [case inventory](../04-validation/07-case-inventory.md) does not define | **yes** |

## What the driver does and does not do

The driver currently implements the `preflight` and `network` suites and registers the rest as **skipped with a reason**. It does not yet provision, start, or tear down remote harnesses; `-KeepRunning` therefore warns that it has no effect rather than pretending otherwise. Every case it cannot run is reported as skipped, never as passed.

Corrected after review:

- **It no longer reports a pass for a check it did not perform.** `E-ARCH-01` previously probed port 3080 on every peer and counted a refused connection as proof that the GUI binds loopback. A refused connection to a port where nothing is listening proves nothing. The case now asks the node whether its GUI is actually running first, and reports **skipped** when it is not or when SSH is unavailable.
- **It consumes the descriptors.** Ports, schemes, paths, and the published-versus-backend distinction come from `nodes.json`, so a node on a different published port or a different topology is tested correctly. `E-ARCH-02` probes the **published** endpoint, not the raw backend port.
- **The engine range is parsed, not regex-approximated.** `^22.19 || >=24` accepts `v22.19.0`, `v22.20.1`, `v24.0.0`, and `v25.1.0`, and rejects `v22.18.0` and `v23.0.0`.

## Verified output on the reference environment

`mesh-doctor.ps1` was run against this machine and its tailnet, and `mesh-e2e.ps1 -Suite network` was run alongside it. The full result is recorded in [the observed run](../04-validation/06-observed-run.md), and the state after node L was pointed at a reachable peer is in [the re-run](../04-validation/08-rerun-after-ssh.md). What is established at this revision:

- `big` (this machine), `vmi2916953` (node L), and the second local home are all present at the addresses recorded in `nodes.json` — no drift.
- Node L answers over SSH, and its runtime (`v22.22.2`, pnpm `12.4.2`) satisfies the engine range. The local runtime `v22.19.0` does too.
- **The only red row is the macOS descriptor**, because no macOS device exists on this tailnet.
- **Funnel is on for `tcp://big.tail652dda.ts.net:22`**, and the Funnel check correctly distinguished that from a *mesh* port being exposed. This is a live risk on this machine, not a hypothetical one.
- No macOS device exists on `tail652dda.ts.net`.
- SSH to the Linux aliases fails, so the dependent checks report **skipped**.

What was **not** established, and was previously overclaimed: nothing about the GUI loopback posture, because no harness was running on any probed peer. That is a skip, not a pass.

## Running them

```powershell
# Preflight only - correct today, and the gate for everything else.
pwsh harness-mesh/assets/mesh-doctor.ps1
pwsh harness-mesh/assets/mesh-doctor.ps1 -Only L

# The driver, with the two suites that need no mesh code.
pwsh harness-mesh/assets/mesh-e2e.ps1 -Suite preflight
pwsh harness-mesh/assets/mesh-e2e.ps1 -Suite network
pwsh harness-mesh/assets/mesh-e2e.ps1 -Suite all -Case 'E-ARCH-*'
```

A run writes into `assets/runs/<timestamp>/`: `results.csv`, `tailscale-status.json`, and `tailscale-serve.txt`. Run directories are generated artifacts and are not kept in this folder.

## The case inventory check

[The case inventory](../04-validation/07-case-inventory.md) is authoritative for every case id.

```powershell
pwsh harness-mesh/assets/verify-case-inventory.ps1
```

It scans every Markdown file in this folder for case-id tokens, fails on any id the inventory does not define, and separately warns about ids the inventory defines but no document references. On the current revision it reports 190 defined ids and, after the review corrections, no undefined references.
