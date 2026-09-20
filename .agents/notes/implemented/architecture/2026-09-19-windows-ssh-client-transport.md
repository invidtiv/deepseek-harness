# Agent Note: Windows SSH client transport

Status: implemented

English | [中文](2026-09-19-windows-ssh-client-transport.zh.md)

## Problem

The [POSIX SSH execution providers](2026-09-11-posix-ssh-runtime.md) carry the remote helper over one OpenSSH control master (`ssh -M -S`) and add each program stream with an `-O forward` control command. That client transport is unavailable on a Windows Harness host: Win32-OpenSSH implements no control-master multiplexing, and `ssh -M -S` fails with `getsockname failed: Not a socket`, so a Windows deployment cannot compose the SSH provider family at all. The remote helper, digest verification and provider contracts are portable; only the client-side stream transport is not.

## Decision

`SshConnection` selects its client transport from the running platform. `internals.platform` is the injectable seam, so a spec can exercise either branch on any host. On Linux and macOS the control master is unchanged. On Windows the helper is carried by an ordinary `ssh -T` stdio session (`buildDirectArgv`), and each program stream opens a dedicated no-command OpenSSH session that forwards a loopback port to the helper's reserved remote socket (`buildForwardArgv`: `ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:<port>:<remote>`). The client reserves an ephemeral loopback port, retries the TCP connect until the forwarder accepts it or the request deadline passes, and kills that session when the stream closes or the connection unloads. A forwarder must not carry `ClearAllForwardings=yes`, because that option clears the forwarding the session exists to create.

Loopback binds to `127.0.0.1` only, and the stream endpoint is still authenticated by the same TLS-PSK capability, so the change moves bytes over a loopback TCP hop instead of a local Unix socket without weakening stream authentication. The remote helper host still requires Linux or macOS.

## Alternatives considered

**Run the Harness on the remote host.** That is the deployment model the [POSIX SSH decision](2026-09-11-posix-ssh-runtime.md) already rejects: it moves model credentials, Session storage and plugin state rather than supplying a portable client transport.

**Use WSL as the SSH client.** WSL1 can supply a POSIX `ssh` with control-master multiplexing, but the Harness would then depend on a VM or translation layer that may be absent or unable to start; WSL2 additionally needs firmware virtualization. The product must run on the host that launches `dsh`.

**Unify every platform on the loopback transport.** One code path and no platform branch, but each POSIX stream would spawn an extra `ssh` process and authenticate afresh. The control master already multiplexes streams over one authenticated connection, so the common case keeps the faster transport.

**Implement multiplexing on Windows.** Win32-OpenSSH does not implement `ControlMaster` or `ControlPath`; there is no client flag or named-pipe substitute to target.

## Consequences

A Windows stream costs one extra `ssh` process and one loopback TCP connection. Port reservation and process startup are not atomic, so the connect is retried until it succeeds; `requestTimeoutMs` bounds that wait. Releasing a stream kills its forwarder instead of issuing `-O cancel`. The provider family now runs on Windows, macOS and Linux Harness hosts while the remote helper host remains POSIX.

## Verification

`packages/ssh/ssh/tests/direct-transport.spec.ts` drives the Windows branch on any host through the `internals.platform` seam: launch argv, loopback forward and release, forwarder exit, never-binds timeout, unreadable reserved address, caller abort, and disposal. The POSIX lifecycle suites keep pinning the control-master branch. Live acceptance ran the real connection from a Windows host against a POSIX helper: digest verification, remote directory listing, two forwarded streams, and a remote `/bin/sh` process with its exit observation.
