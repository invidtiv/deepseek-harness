---
description: "Re-run of the plan tooling after node L was pointed at a reachable peer, recorded because it closes a precondition the earlier run reported as blocking."
kind: "validation"
---

# Re-run after the peer was made reachable

The [observed run](06-observed-run.md) recorded SSH authorization as the blocking precondition for the whole cross-machine tier and reported the dependent checks as skipped. That precondition is now **closed**, so the affected rows are recorded here rather than edited into the earlier document, which stays as what it was.

## What changed

Node L's descriptor now names a host that accepts this machine's key:

```
$ ssh -o BatchMode=yes bsa-contabo "hostname; whoami; uname -sr; node --version; pnpm --version; tailscale ip -4"
vmi2916953
bsdev
Linux 6.8.0-139-generic
v22.22.2
12.4.2
100.115.155.120
```

The descriptor records the alias `bsa-contabo`, the tailnet name `vmi2916953.tail652dda.ts.net`, the tailnet address `100.115.155.120`, and the public address `212.47.64.174`. Both Node and pnpm satisfy the engine range `^22.19 || >=24`.

## The doctor on node L, now green

| Node | Check | Ok | Skipped | Detail |
|---|---|---|---|---|
| L | tailscale-peer | yes | no | `DNSName=vmi2916953.tail652dda.ts.net. ips=100.115.155.120,fd7a:115c:a1e0::7001:9b8f online=True` |
| L | address-current | yes | no | recorded `100.115.155.120` matches the tailnet |
| L | ssh | yes | no | `mesh-doctor-ok`, Node `v22.22.2`, pnpm `12.4.2` |
| L | remote-runtime | yes | no | satisfies the engine range |
| L | mesh-bind-address | yes | no | no unix socket yet, because the listener is opt-in |
| machine | not-funnel-exposed | yes | no | Funnel is on for `tcp://big.tail652dda.ts.net:22`, none of which is a mesh port |

The rows the earlier run reported as red or skipped for node L are now green. Nothing in the mesh itself changed, because none of it exists yet.

## The whole run, at this revision

```
W       tailscale-peer      True   address-current True   local-runtime True (v22.19.0)   mesh-bind-address True
L       tailscale-peer      True   address-current True   ssh True   remote-runtime True (v22.22.2)   mesh-bind-address True
X       tailscale-peer      True   address-current True   local-runtime True   mesh-bind-address True
M       device-present      False  no macOS device is present on tailnet tail652dda.ts.net
machine not-funnel-exposed  True   Funnel is on for tcp://big.tail652dda.ts.net:22, none of which is a mesh port
```

**One row is red: the macOS descriptor.** Three revisions ago the same run had three failures and four skips. The mesh-port rows are green because the listener is opt-in and nothing is bound yet, which is the shipped default rather than a pass.

## A node with a public address

Node L is a Contabo VPS: it has a public IPv4 address and offers a tailnet exit node. That makes the Funnel rule concrete rather than theoretical. Nothing on this node may ever be published with `tailscale funnel`; the mesh endpoint is tailnet-only by `tailscale serve`, and the GUI stays on loopback. The descriptor carries that warning next to the node.

## Two limits that remain, and are not gaps of the same kind

1. **No third machine accepts a key.** `kimi`, `tigs-pi`, and `ai` reject every user tried. The unpaired-node and cloned-identity roles are therefore played by a **second harness home on the driver machine**, at `C:/Users/tiaz/.dsh-mesh-x`, which is a genuinely different node identity, grant store, and credential pair, and is what those cases require. It is not a different operating system, and the cases that need one are macOS-dependent and stay unrun.
2. **SSH is one-way.** `ssh 100.122.125.15` from `bsa-contabo` is refused, so the driver is pull-based: W drives L, never the reverse. The plan never assumes otherwise, and the provisioning script is delivered over stdin rather than pulled by the remote.

## What this does and does not change

**Changes:** `E-00` is verified rather than blocked; the cross-machine tier has a real peer; `E-01` is verified for node L; and the doctor's per-node rows for L are green instead of skipped.

**Does not change:** every case that needs the mesh packages is still unexecuted, because none of them exists. The architecture cases remain skipped for the reason they were: no harness is running on either side, so a refused connection would still prove nothing.

## Reproducing

```powershell
pwsh harness-mesh/assets/mesh-doctor.ps1 -Only L
pwsh harness-mesh/assets/mesh-doctor.ps1
```
