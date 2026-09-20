---
description: "Live evidence gathered from this machine and its Tailscale tailnet: inventory, MagicDNS, serve state, SSH reachability, DSH home layout, and session file format."
kind: "research"
---

# Environment evidence

Everything in this document was produced by running a command on this machine (Windows, DSH checkout) against itself or against its tailnet. Commands are quoted so each fact can be re-derived. Nothing here is inferred from documentation.

## 1. The tailnet

`tailscale status` and `tailscale status --json` on this machine report:

| Fact | Value |
|---|---|
| Tailscale version | `1.102.2` |
| MagicDNS suffix | `tail652dda.ts.net` |
| MagicDNS enabled | `true` |
| Tailnet owner | one personal account, with several `tagged-devices` on the same tailnet that are not owned by it |
| This machine | `big` — `big.tail652dda.ts.net`, `100.122.125.15`, `fd7a:115c:a1e0::b001:7d8c`, OS `windows`, node ID `nBffwsPKqc11CNTRL` |

The `Self` and `Peer` objects in `tailscale status --json` carry the fields a mesh plugin needs to auto-fill an address, verified present on both: `ID`, `NodeID`, `PublicKey`, `HostName`, `DNSName` (trailing dot included), `OS`, `TailscaleIPs` (IPv4 then IPv6), `Online`, `Tags`, `CurAddr`, `Relay`, `LastSeen`, `UserID`. Example: `Self.DNSName = "big.tail652dda.ts.net."`, `Peer.DNSName = "xeon.tail652dda.ts.net."`.

MagicDNS resolution works from this machine:

```
$ nslookup big.tail652dda.ts.net
Server:  magicdns.localhost-tailscale-daemon
Address:  fd7a:115c:a1e0::53
Name:    big.tail652dda.ts.net
Address:  100.122.125.15
```

`tailscale whois 100.122.125.15` returns the machine name, machine ID, both addresses, the owning user name, and the user ID.

**Scope of that fact, corrected after review.** `whois` maps an **address you already hold** to a node. It is not a per-request identity source. Two consequences follow, and an earlier draft of this plan got both wrong:

- Under a `tailscale serve` topology the backend's peer is the local proxy, so asking `whois` about the observed source address asks about `127.0.0.1` and matches no tailnet node. The command is useful for a node's *own* address and for a peer address observed under a direct tailnet bind, and nowhere else.
- The LocalAPI `whois` endpoint requires read permission — root or the configured operator user — so even where it applies it is optional corroboration, never a dependency.

### Devices relevant to this plan

| Device | Tailscale IP | OS | State | SSH :22 |
|---|---|---|---|---|
| `big` (this machine) | 100.122.125.15 | windows | — | funnel-exposed on 22 |
| `ai` | 100.116.54.107 | linux | idle | **closed** |
| `kimi` | 100.106.46.112 | linux | idle | open, key rejected |
| `tigs-pi` | 100.109.254.34 | linux | idle | open, key rejected |
| `vmi2916953` | 100.115.155.120 | linux | active, offers exit node, direct `212.47.64.174:41641` | open, key rejected |
| `xeon` | 100.92.214.18 | windows | active | open |
| `bs7` | 100.114.112.24 | windows | active | open |

**There is no macOS device on this tailnet.** The user requirement names macOS as a third platform. This plan specifies macOS behavior and covers it by the repository's own platform matrix and by code inspection, but it **cannot** be exercised end to end on this tailnet. See [the phased plan](../03-implementation/03-phased-plan.md) for how that gap is handled.

### `tailscale serve` state (already in use on this machine)

```
$ tailscale serve status
# Funnel on:
#     - tcp://big.tail652dda.ts.net:22

|-- tcp://big.tail652dda.ts.net:22 (Funnel on)
|-- tcp://100.122.125.15:22
|--> tcp://localhost:22
|-- tcp://big.tail652dda.ts.net:8766 (tailnet only)
|-- tcp://100.122.125.15:8766
|--> tcp://127.0.0.1:8765

https://big.tail652dda.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:3773

https://big.tail652dda.ts.net:8443 (tailnet only)
|-- / proxy http://127.0.0.1:8765
```

Three facts matter:

1. **`tailscale serve` is already the established pattern on this tailnet.** An HTTPS listener on `big.tail652dda.ts.net:8443` proxying to a loopback port is exactly the topology this plan recommends for the mesh control plane.
2. **Funnel is in use, and it is the wrong tool for the mesh.** Port 22 is published to the public internet. The mesh runbook must default to `tailscale serve` and explicitly warn when a mesh port would be reachable by Funnel.
3. The `serve` proxy targets are loopback addresses. This confirms the backend can stay bound to `127.0.0.1`, which keeps the harness's own listener posture unchanged.

### SSH reachability

`ssh -o BatchMode=yes -o User=<u> -o ConnectTimeout=6 <ip> "hostname"` against the four Linux hosts completes key exchange and then fails authentication for every user tried (`root`, `bsdev`, `tiago`, `ubuntu`, `dsh`): `Permission denied (publickey)`. `ai` refuses the TCP connection outright.

This machine's `~/.ssh/config` contains a **stale** entry:

```
Host kimi
    HostName 100.84.218.5
    User root
```

`kimi`'s current tailnet address is `100.106.46.112`, not `100.84.218.5`, and `tailscale status` does not list `100.84.218.5` at all. A plain `ssh kimi` therefore times out. This is itself an edge case the mesh design must handle: **a stored address goes stale when a node is re-registered**, which is why the design stores both the MagicDNS name and the IP and prefers the name.

Keys present in `~/.ssh`: `id_ed25519`, `bsdev`, `myserver`, plus `authorized_keys` and `acl-backup.txt`.

**Conclusion for the validation plan.** SSH is reachable at the transport level on three Linux hosts; the *authorization* step (installing a public key on the remote host) has not been performed from this machine and is a documented precondition of the cross-machine suite, not something the suite can do for itself.

## 2. The DSH installation on this machine

| Fact | Value |
|---|---|
| `$DSH_HOME` | `C:/Users/tiaz/.dsh` |
| Home layout | `attachments/`, `llm-deepseek/`, `logs/`, `profiles/`, `sessions/`, `storages/`, `.anonymous-user-id`, `.credentials.yaml`, `settings.yaml` |
| Installed profiles | `web`, `acp` (`node_modules` shared at `profiles/node_modules`) |
| Web profile bundles | `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app` |
| Web profile patch | inserts a third-party `ah-bridge` row and disables one inventory row |

The live web profile files, read verbatim:

- `$DSH_HOME/profiles/web/cordis.yml` is an empty list, with a comment stating the tree is composed as patches and that the profile's own `cordis.patch.yml` is the file to edit.
- `$DSH_HOME/profiles/web/cordis.patch.yml` holds the user's patch layer.
- `$DSH_HOME/profiles/web/package.json` declares `dsh.profile.bundles` and `patchReload: live`.

**This is where a mesh row would go for a real two-machine test**, via `--patch` overlay or by editing the profile patch.

### Session storage, verified

```
$DSH_HOME/sessions/<encoded-cwd>/<session-uuid>/session.v3.jsonl.zstd
$DSH_HOME/sessions/<encoded-cwd>/<session-uuid>/session.jsonl.zstd
```

Observed encoded directory names on this machine include `--C-Users-tiaz-Desktop-Github-deepseek-harness--` and `--home-bsdev-deepseek-harness--` — a Linux home path from a previous machine is present in the same store, which shows the encoding is a path spelling, not a machine identity.

Observed file sizes for the checkout's sessions: 38,672 / 38,734 / 136,829 / 203,960 / 208,037 / 326,642 / 535,590 / 886,979 bytes. Two different filenames (`session.jsonl.zstd` and `session.v3.jsonl.zstd`) coexist in one store.

Derived state lives under `$DSH_HOME/storages/`: `session_projcache/` (one JSON file per session, plus `.tmp` files mid-write), `session_projcache.json`, and `workspace.json`.

**Implications carried into the design:**

- A session is a directory containing a compressed append-only log plus a derived cache. Two harnesses appending to one log is not a supported operation and there is no lock in the format to detect it.
- The `.tmp` files show the cache writer is not atomic-with-the-log; a sharing scheme that copies files around would race with it.
- The format generation is in the filename, so a mesh peer must not assume a fixed filename when it reasons about a session it does not own. The design sidesteps this entirely by reading through the peer's own API, never through the filesystem.

## 3. Ports already taken on this machine

From the tailnet and serve state: 22 (SSH, Funnel), 3080 (the default `dsh web` port), 3773 and 8765 (loopback backends behind `tailscale serve`), 8766 (tailnet-exposed TCP).

A mesh listener default must avoid these. The plan proposes **8737**, and makes the port a required, validated config field with a bind-time collision check that reports the conflicting owner.

## 4. The same probes, re-run by the plan's own tooling

Everything above was reproduced by [the preflight doctor](../assets/mesh-doctor.ps1) after it was written, and the suite driver was run alongside it. The recorded output is in [the observed run](../04-validation/06-observed-run.md).

Two findings from that run matter most here: **Funnel is on for TCP port 22 on this machine** and the check correctly distinguished that from a *mesh* port being exposed, and **SSH authorization to the Linux peers is unresolved**, so every check that depends on it is reported as skipped rather than passed.

The run also corrected a claim made earlier in this folder: probing a closed port on a machine where no harness is running establishes nothing about that machine's bind address. The driver now requires the listener to be running before a refusal counts.

## 5. What could not be verified here

| Claim | Why not | What would settle it |
|---|---|---|
| macOS behavior end to end | No macOS device on this tailnet | Add one, or accept the repository's platform matrix as the only evidence |
| ~~Pairing across machines~~ | **No longer a gap.** `ssh bsa-contabo` succeeds with the default key against `vmi2916953` (Linux 6.8, Node v22.22.2, pnpm 12.4.2) | The cross-machine suite now has a reachable peer; see [cross-machine e2e](../04-validation/03-cross-machine-e2e.md) |
| SSH from the peer back to this machine | Refused: `ssh 100.122.125.15` from `bsa-contabo` fails `publickey` | Only matters for a push-model driver; the suite is pull-based |
| `tailscale serve` behavior for a new port | Only existing listeners were inspected | `tailscale serve --bg --https=8443 http://127.0.0.1:8737` then probe |
| Windows Firewall behavior for the mesh port | No listener has been started yet | Start one and probe from a peer |
| Tailscale ACLs for a new port | This tailnet's ACL policy is not readable from the client | `tailscale debug netmap` on a peer, or the admin console |
