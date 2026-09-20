---
description: "What `tailscale serve` actually does to a backend, the three corrected topologies (unix socket, loopback TCP, direct tailnet bind), and the exact commands to publish, verify, and un-publish a mesh node."
kind: "operations"
---

# Tailscale runbook

Every command below was run against Tailscale `1.102.2` on this machine, except where a line is marked unverified. Values that differ per node are written as `<placeholder>`.

## What this machine already serves

`tailscale serve status`, re-run while writing this runbook (TCP listeners on 22 and 8766, and an HTTPS listener on the bare name, are omitted here):

```
# Funnel on:
#     - tcp://big.tail652dda.ts.net:22

|-- tcp://big.tail652dda.ts.net:22 (Funnel on)

https://big.tail652dda.ts.net:8443 (tailnet only)
|-- / proxy http://127.0.0.1:8765
```

Three facts follow, and they shape the rest of this runbook:

1. **Funnel is ON for TCP port 22 on this machine.** A mesh port appearing in a `# Funnel on:` block is the failure the preflight doctor checks for.
2. **HTTPS `:8443` is already published** to `127.0.0.1:8765`, so it is not free for the mesh. Always read `tailscale serve status` before claiming a published port.
3. Serve is already the established pattern here, every existing proxy target is loopback, and the node is `big` at `100.122.125.15` / `fd7a:115c:a1e0::b001:7d8c` on tailnet `tail652dda.ts.net`.

## The fact that shapes every command below

`tailscale serve` terminates TLS itself and proxies to a **local** target. The backend's TCP peer is the local `tailscaled` process, never the remote device.

| Operators often assume | What is true |
|---|---|
| The backend sees the remote device's tailnet address | The peer is the local `tailscaled` process on the same machine |
| The backend sees the real remote address in `X-Forwarded-For` | It does, but that header is added by Serve and is not in the Serve documentation (it is source-only), and a local process can write it too |
| Serve authenticates the caller to the backend | Serve adds advisory identity headers; the backend still authenticates every request itself |
| PROXY protocol can carry the real peer address | PROXY protocol is supported only for TCP forwarding; it is explicitly rejected for HTTP/HTTPS, and it is not supported with a unix socket target |

### Headers Serve adds

| Header | Populated when | Notes |
|---|---|---|
| `Tailscale-User-Login` | HTTP/HTTPS Serve, when WhoIs resolves the client | Non-ASCII values are RFC 2047 Q-encoded; Serve strips inbound copies of this header on the Serve path |
| `Tailscale-User-Name` | same | same |
| `Tailscale-User-Profile-Pic` | same | same |
| `Tailscale-Headers-Info` | Serve | Source-only; not in the Serve documentation |
| `Tailscale-Funnel-Request: ?1` | Funnel | Marks a request that arrived through Funnel |
| `X-Forwarded-Host`, `X-Forwarded-Proto: https`, `X-Forwarded-For` | Serve | `X-Forwarded-For` carries the real tailnet client address. Source-only; not in the Serve documentation |

The absences matter as much as the presences:

- **Funnel traffic carries no identity headers at all.**
- **Tagged devices are not populated with identity headers.**
- **When WhoIs fails, the identity headers are absent entirely** — there is no empty-value or partial header to test against.

### Advisory means advisory

Tailscale's own documentation concedes that a process connecting directly to the backend bypasses Serve and can forge these headers, and describes "listen on localhost" as limiting tampering to other services on the Serve device. That is a blast-radius reduction, not an authentication control.

In the mesh, no Serve identity header and no `X-Forwarded-For` value is ever an authorization input. Authorization is exclusively the bearer token established by the SPAKE2 pairing handshake. Headers are advisory display and audit annotations that any local process can forge, and that are absent for Funnel traffic and tagged devices. [The security runbook](02-security-runbook.md) states the same rule from the credential side.

## The three topologies

| Property | T1 — unix socket (default) | T2 — loopback TCP | T3 — direct tailnet bind |
|---|---|---|---|
| Publish command | `tailscale serve --bg --https=<publishedPort> unix:<socketPath>` | `tailscale serve --bg --https=<publishedPort> http://127.0.0.1:<port>` | none; the listener binds the node's own Tailscale address |
| The listener binds | a unix socket, and no TCP port at all | `127.0.0.1:<port>` | `100.64.0.0/10` or `fd7a:115c:a1e0::/48` |
| TLS | terminated by Serve | terminated by Serve | none at the application layer; WireGuard encrypts and authenticates the transport |
| The local door | the socket file's permissions | any local process can connect to the loopback port | any process on the node can reach an address bound on the node |
| Peer address authenticity | none; the peer is the local proxy | none; the peer is the local proxy | authentic for tailnet traffic |
| Per-source rate limiting and source pinning | unavailable | unavailable | available |
| `tailscale whois` corroboration | not usable for a request | not usable for a request | usable; it needs root or operator permission, so treat it as optional |
| Listener config (`listen`) | `{ kind: unix, path }` | `{ kind: loopback, port }` | `{ kind: tailscale, port }` |

**Note on the labels.** This runbook carries the corrected naming. Other documents in this plan still use the pre-review labels: the proposal's "T1" is loopback plus serve (this runbook's T2), its "T2" is the direct tailnet bind (this runbook's T3), and its "T3" is serve with a custom hostname (T2 with a different published port). Map them by content, not by number, until those documents are corrected. [The troubleshooting runbook](03-troubleshooting.md) lists the places that still disagree.

## Topology T1 — unix socket, the default

The mesh listener binds a unix socket and Serve proxies the published HTTPS port to it. There is then **no local TCP port to connect to**, so the direct-loopback spoofing path of T2 does not exist. Socket file permissions are the only local door.

```bash
# 1. Confirm Tailscale is up and note this node's names and addresses.
tailscale status --json | jq '{self: .Self.DNSName, ips: .Self.TailscaleIPs}'
# => {"self":"big.tail652dda.ts.net.","ips":["100.122.125.15","fd7a:115c:a1e0::b001:7d8c"]}

# 2. Confirm the published port is free before claiming it.
tailscale serve status
# On this machine 8443 is already published to 127.0.0.1:8765. Choose another port,
# or remove that mapping first. Do not silently take it over.

# 3. Publish the mesh listener. The listener must already hold <socketPath>.
tailscale serve --bg --https=<publishedPort> unix:<socketPath>

# 4. Verify: tailnet-only, the right target, and NOT Funnel.
tailscale serve status
```

The expected proxy line is an HTTPS listener marked `(tailnet only)` whose target is `unix:<socketPath>`. **Unverified:** how `tailscale serve status` renders a unix-socket target. Tailscale's CLI accepts `unix:<path>` as a target, but this machine has no unix-socket mapping to read, so read the printed form from your own output rather than from this document.

```bash
# 5. Inspect the local door.
ls -l <socketPath>
```

The socket mode must satisfy two constraints at once: tight enough that no other local user can connect, and permissive enough that the `tailscaled` process can. How those reconcile depends on which user runs `tailscaled` on that node — **unverified here** — so check the mode after the first published request instead of assuming it.

**The config supports this.** `dsh-mesh-agent` declares `listen` as a discriminated union, so T1 is `{ kind: unix, path }` and needs no separate field. An earlier revision declared only `bindAddress` and `port`, which made T1 inexpressible; that is fixed in [types and configuration](../../harness-mesh/03-implementation/02-types-and-config.md).

## Topology T2 — loopback TCP

Simpler: the listener binds an ordinary loopback port, and Serve publishes it.

```bash
tailscale serve --bg --https=<publishedPort> http://127.0.0.1:<port>
tailscale serve status
ss -ltn | grep <port>          # Linux; Get-NetTCPConnection -LocalPort <port> on Windows
```

Any local process can connect to `127.0.0.1:<port>` directly, bypassing Serve entirely, and can therefore forge every advisory header Serve would have added. This topology is safe **only** because authorization never reads those headers. Per-source rate limiting and source pinning are unavailable here: every request arrives from the local proxy, or from a local process.

T2 is the right choice when the listener cannot create a unix socket, or when a local tool must reach the mesh API without going through Serve.

## Topology T3 — direct tailnet bind

The listener binds the node's own Tailscale address and serves plain HTTP over WireGuard.

```yaml
- id: mesh-agent
  name: '@deepseek-ai/dsh-mesh-agent'
  config:
    enabled: true
    listen: { kind: tailscale, port: 8737 }   # this node's own Tailscale address
    publishedScheme: http
    publishedPort: 8737
```

```bash
# Confirm the bind is on the tailnet address only.
ss -ltn | grep 8737
# Prove the LAN address does not answer.
curl -sS --max-time 3 http://192.168.2.27:8737/mesh/v1/hello || echo "refused, as intended"
```

Any address outside `100.64.0.0/10` and `fd7a:115c:a1e0::/48` fails the plugin load with `MESH_BIND_NOT_TAILSCALE`. A bind on `0.0.0.0` or a LAN address would expose the control plane to everything on the local network.

T3 is the **only** topology in which the observed peer address is authentic, because nothing terminates and re-originates the connection in between. That is what makes per-source rate limiting, source pinning, and optional `tailscale whois` corroboration possible. It does not make a source address an authentication input; the bearer token is still the only credential.

A process on the node itself can also reach an address bound on the node, so T3 does not exclude local callers. What T3 adds is that a **tailnet** caller's address is real and can be corroborated.

T3 is the fallback when HTTPS certificates are disabled for the tailnet. It gives up application-layer TLS — WireGuard still encrypts the transport — and nothing else.

## Turning Funnel off

If a mesh port is ever Funnel-exposed, remove it immediately:

```bash
tailscale funnel status                 # lists what the public internet can reach
tailscale funnel --https=<port> off     # for an HTTPS listener
tailscale funnel --tcp=<port> off       # for a raw TCP listener
tailscale serve status                  # confirm 'Funnel on' no longer names the mesh port
```

**Never publish a mesh port with Funnel.** Funnel serves the public internet, and Funnel traffic carries no identity headers at all, so a Funnel-exposed mesh port would also lose the advisory annotations. The mesh's whole premise is a private tailnet.

## Certificates

With T1 and T2, `tailscale serve` obtains and renews the certificate for the node's own `*.ts.net` name, and the harness never sees a key. With T3 there is no certificate at all, and none is needed.

```bash
# Probe whether HTTPS certificates are enabled for this tailnet.
tailscale cert big.tail652dda.ts.net --cert-file /tmp/probe.crt --key-file /tmp/probe.key
```

A failure here means the tailnet has HTTPS certificates disabled in the admin console. Use T3; do not fall back to Funnel.

## ACLs

A tailnet's ACL policy governs which devices may reach the published port. The mesh does not depend on the ACL for authorization, but the ACL is a useful second layer. On a tailnet with per-user devices, a policy of this shape restricts the mesh port to the owner's own devices:

```json
{
  "acls": [
    { "action": "accept", "src": ["autogroup:member"], "dst": ["*:22"] },
    { "action": "accept", "src": ["autogroup:member"], "dst": ["autogroup:member:8443"] }
  ],
  "tagOwners": {
    "tag:mesh-node": ["autogroup:admin"]
  }
}
```

Two cautions:

1. This tailnet contains tagged devices that are not members. `autogroup:member` excludes them, which is the intended shape.
2. **The ACL is not the mesh's authorization.** It cannot express "node A may read my sessions but not drive them". It governs reachability; grants govern operations.

## Verifying the whole path

```bash
# T1: the listener on the node itself, over the socket.
curl -sS --unix-socket <socketPath> http://localhost/mesh/v1/hello | jq

# T2: the listener on the node itself, over loopback.
curl -sS http://127.0.0.1:<port>/mesh/v1/hello | jq

# T1 and T2: through Serve, from the node itself.
curl -sS https://<node>.<tailnet>.ts.net:<publishedPort>/mesh/v1/hello | jq

# T3: the listener on the node itself, on its own Tailscale address.
curl -sS http://<node-tailscale-ip>:<port>/mesh/v1/hello | jq

# From the peer, whichever topology is in use.
ssh <peer> "curl -sS https://<node>.<tailnet>.ts.net:<publishedPort>/mesh/v1/hello" | jq

# The GUI must remain unreachable from the peer.
ssh <peer> "curl -sS --max-time 3 http://<node-tailscale-ip>:3080/ || echo refused"
```

`tailscale ping <peer>` distinguishes a direct path from a relayed one, which explains a latency change without a functional failure.

## Asking tailscaled about an address (LocalAPI)

Tailscale exposes a local HTTP API that the CLI itself uses. It has **no public documentation page**; everything below is read from the Tailscale source and from CLI behavior, and it should be treated as an implementation detail that can change between versions.

| Platform | Endpoint |
|---|---|
| Linux | unix socket `/var/run/tailscale/tailscaled.sock`; the socket is mode `0666` and authorization is per request by peer uid |
| macOS, CLI/tailscaled variant | unix socket `/var/run/tailscaled.socket` |
| macOS, App Store and macsys variants | a random loopback TCP port plus a token file under `/Library/Tailscale` |
| Windows | named pipe `\\.\pipe\ProtectedPrefix\Administrators\Tailscale\tailscaled` |

`GET /localapi/v0/whois?addr=<ip[:port]>` maps an **address** to a node. It needs read permission: root, or the operator configured for the tailnet.

Two consequences for this runbook:

- `tailscale whois <ip>` needs an address you already hold. **There is no command that maps "this request" to a node** — only the address you can observe.
- Under T1 and T2 the address you can observe is the local proxy, so whois answers "this machine". It is informative only under T3, and even there it is optional corroboration that requires permission you may not have.

## Undoing everything

```bash
tailscale serve --https=<publishedPort> off
tailscale serve status
```

Then set the composition's `mesh-agent.enabled` to `false`.

Under T1 and T2, removing the serve mapping closes the network path; under T1 the socket file is still on disk and its permissions are the remaining door, so delete it when the listener is disabled for good. Under T3 there is no serve mapping to remove, and stopping the plugin closes the listener.

## Per-node checklist

- [ ] `tailscale status` shows the node online, and MagicDNS resolves its name from the peer.
- [ ] `tailscale serve status` was read **before** a published port was chosen; no existing mapping was taken over.
- [ ] The published listener is marked `(tailnet only)`, or the port does not appear at all.
- [ ] `tailscale funnel status` does not name the mesh port.
- [ ] The listener is reachable only through the selected topology: a socket (T1), loopback (T2), or the node's own Tailscale address (T3).
- [ ] The GUI port is unreachable from the peer.
- [ ] The doctor's per-node rows are green, including the Funnel row.

## What this runbook cannot verify

| Claim | Why not | What would settle it |
|---|---|---|
| How `tailscale serve status` renders a `unix:<path>` target | No unix-socket mapping exists on this machine to read | Publish one and read the output |
| That `dsh-mesh-agent` can bind a unix socket | The listener does not exist; its declared config has no socket path | Implement it, then run the T1 commands above |
| The LocalAPI paths and the `whois` permission model | There is no public Tailscale documentation page for the LocalAPI | Read the source, or probe the endpoint on each platform |
| Whether a second `serve` mapping can claim a port another mapping already holds | Untested here; `:8443` is already in use on this machine | Try it on a spare port and read the error |