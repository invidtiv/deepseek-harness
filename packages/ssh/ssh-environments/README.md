---
description: "Settings-backed registry of named POSIX SSH environments for the DeepSeek Harness"
kind: "package-reference"
---

# @deepseek-ai/dsh-ssh-environments

English | [中文](README.zh.md)

## Summary

`dsh-ssh-environments` owns the deployment's named SSH environments. It registers one `ssh-environments` settings namespace, keyed by a stable environment id, and exposes `ctx.sshEnvironments` with `list`, `get`, and `resolve`. An entry supplies the OpenSSH connection options one [SSH provider family](../README.md) deployment needs; the registry opens no connection, stores no secret, and contributes no model-visible content.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The Web bundle composes this service beside a settings provider, so the Plugins page's **SSH environments** card can define the ids; a deployment that executes on a server also composes the [SSH provider family](../ssh/README.md) and names one of those ids. Configure environments in the `ssh-environments` settings section:

```yaml
ssh-environments:
  environments:
    build01:
      label: Build 01
      host: build01.example
      user: alice
      identityFile: ~/.ssh/id_ed25519
      proxyJump: bastion
```

The [SSH connection](../ssh/README.md) reads the registry by service name through its `environment` config field, so a deployment selects a named environment without repeating its options. `ctx.sshEnvironments.resolve(id)` returns validated `SshEnvironment` connection options with strict host-key checking and a 10-second, 3-probe keepalive applied. An unknown id throws `SshEnvironmentUnknownError`; the registry never falls back to a default host.

## Model Experience

None, as the registry stores deployment connection configuration and opens no connection; its consumers own every model-visible operation.

#### KV Cache effect

This registry contributes no request-prefix content.

## Known Limitations and Deferred Work

- **No interactive authentication.** The SSH provider enables `BatchMode`; password and passphrase prompts are unavailable, so a deployment authenticates with a key or an SSH agent.
- **One flat settings section.** Environments live in a single settings namespace with no secret slot; a future passphrase or token field must use `role('secret')` so settings wire redaction removes it.
- **The settings card edits two fields per environment.** The [SSH environments card](../../client/ui-settings-plugins/README.md) binds this namespace through the client settings-scope seam and edits each environment's identifier and OpenSSH destination. Every other option — `identityFile`, `identityAgent`, `proxyJump`, `configFile`, host-key policy, and timeouts — is written back unchanged, so it comes from `$DSH_HOME/settings.yaml` or `~/.ssh/config`.
- **No connection ownership.** The registry resolves options; it never opens, keeps alive, or reconnects a connection.
- **No invariant companion.** No runtime invariant companion is published because the registry owns no independent runtime state: it reads one settings namespace and returns detached values, and the settings provider's own tests observe every durable relation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

An environment entry carries connection references (a key path, an agent socket, or a config file path), never key material or a passphrase. Password authentication stays unavailable because the connection enables `BatchMode`; a future secret slot must declare `role('secret')` on the settings schema so wire redaction removes it.

</details>
