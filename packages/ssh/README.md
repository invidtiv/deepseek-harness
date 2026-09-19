---
description: "The POSIX SSH provider family: shared connection, remote filesystem, managed subprocesses and file-effect sandbox."
kind: "package-group"
---

# ssh/ — POSIX remote execution providers

English | [中文](README.zh.md)

## Summary

This family runs files, ordinary processes, terminals and sandbox enforcement on POSIX SSH hosts while the Harness stays local. A shared OpenSSH connection and installed helper support the existing filesystem, subprocess and sandbox interfaces, and a deployment that reaches several hosts composes one connection per environment behind the world router. Use it in a custom profile that swaps the local providers for this family — the shipped overlays are [`ssh-remote`](../../apps/cli/config/examples/ssh-remote/cordis.yml) for one host and [`ssh-multi`](../../apps/cli/config/examples/ssh-multi/cordis.yml) for several — because exactly one row may register each of `ctx.fs`, `ctx.subprocess` and `ctx.sandbox`.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>
## Packages

| Package | Responsibility | Service |
|---|---|---|
| [`ssh`](ssh/README.md) | Connection, helper identity and transport lifecycle | `ctx.ssh` |
| [`fs-ssh`](fs-ssh/README.md) | Remote file identity, reads and guarded atomic mutations | `ctx.fs` |
| [`subprocess-ssh`](subprocess-ssh/README.md) | Executable lookup, processes, control streams and terminals | `ctx.subprocess` |
| [`sandbox-ssh`](sandbox-ssh/README.md) | Remote file-effect confinement and enforcement facts | `ctx.sandbox` |
| [`ssh-environments`](ssh-environments/README.md) | Named environment configuration and settings-owned registry | `ctx.sshEnvironments` |

<a id="related-documentation"></a>
## Related documentation

- [SSH subsystem](../../docs/subsystems/ssh.md) — shared execution coordinates and transport ownership.
- [POSIX SSH decision](../../.agents/notes/implemented/architecture/2026-09-11-posix-ssh-runtime.md) — alternatives, consequences and verification requirements.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Remote capability implementations retain the shared asynchronous terminal and cancellation interfaces. Local path access must never be inferred from a remote path string.

</details>
