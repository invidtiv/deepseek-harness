# Run Sessions on a remote host over SSH

English | [中文](remote-ssh-workspaces.zh.md)

The [SSH provider family](../../../packages/ssh/README.md) runs file, process, terminal and sandbox work on a POSIX host while the Harness, its model transport and Session storage stay on your machine. This guide gives a Web Session a workspace on that host, so the ordinary `read`, `write`, `edit`, `glob`, `grep`, `bash` and terminal tools operate there with no `ssh`, `scp` or `remote_*` tool.

## Prerequisites

Both endpoints must run Linux or macOS. The SSH providers refuse every other client platform, and the local `ssh` command must support connection multiplexing and Unix-socket forwarding; the server must permit that forwarding.

Authentication is non-interactive. The connection enables `BatchMode`, disables agent forwarding, checks host keys strictly by default, and prompts for nothing, so configure a key or an SSH agent plus a `known_hosts` entry before starting.

## Install the helper on the remote host

The remote host runs a helper entry that `@deepseek-ai/dsh-ssh` exports as `./helper`. That entry is not self-contained: Node resolves its chunk files and the workspace packages it imports from beside it. Install the built helper with those dependencies at one absolute remote path, outside the workspace and outside any writable temporary tree a sandbox backend replaces, then hash the entry:

```sh
shasum -a 256 /opt/dsh-ssh/helper.js
```

The connection verifies that digest before the helper is usable, so an entry edited after installation refuses to connect. Automatic provisioning, a Windows endpoint, and automatic reconnection are not supplied.

## Name the SSH environment

```yaml
ssh-environments:
  environments:
    build01:
      label: Build 01
      host: build01.example
      user: alice
      identityFile: ~/.ssh/id_ed25519
```

Save that section in your `$DSH_HOME/settings.yaml` — no settings card renders it yet, so edit the file directly; the [environment registry](../../../packages/ssh/ssh-environments/README.md) owns its schema and the id-to-connection lookup. An entry stores only connection references — a key path, an agent socket, a config file path — and never key material or a passphrase. Fields you omit keep OpenSSH's own values, so the rest of the connection can stay in `~/.ssh/config`.

The registry registers the `ssh-environments` namespace and resolves a stable id into validated connection options. The Web workspace picker lists those ids through `workspace.environments`, and a remote workspace records the id rather than the address, so renaming the host or the remote directory does not change the workspace identity.

## Start the Web UI against the remote host

```sh
export DSH_SSH_ENVIRONMENT=build01
export DSH_SSH_NODE=/usr/bin/node
export DSH_SSH_HELPER=/opt/dsh-ssh/helper.js
export DSH_SSH_HELPER_HASH=<lowercase sha256 of that file>
export DSH_SSH_WORKSPACE=/home/alice/project
dsh web --patch /absolute/path/to/ssh-remote/cordis.yml
```

The overlay is [`apps/cli/config/examples/ssh-remote/cordis.yml`](../../../apps/cli/config/examples/ssh-remote/cordis.yml); a development checkout passes the same path relative to the repository root. It disables the local filesystem, subprocess and sandbox providers and mounts the named-environment connection with their remote counterparts, because two rows may not register the same `ctx.fs`, `ctx.subprocess` or `ctx.sandbox`. It also points the default file-effect root at `DSH_SSH_WORKSPACE`.

Verify the composition without connecting by dumping the tree:

```sh
dsh web --dump-config --patch /absolute/path/to/ssh-remote/cordis.yml
```

## Choose the remote workspace

Open the Web UI and choose a workspace. The picker lists directories through the composed filesystem, so it shows the remote host's tree one level at a time; an OS-native dialog never appears, because the remote provider reports `addressesHostFilesystem: false` and a native dialog could only return a host path. Create or select the project directory, start a Session, and the file explorer, the viewer and every tool read the same execution world.

## Use more than one server

One composed provider family serves one SSH environment, so a second server needs a second deployment rather than a second workspace. Give the profile its own copy of the overlay with that server's `DSH_SSH_ENVIRONMENT`, `DSH_SSH_WORKSPACE` and helper coordinates, and start one `dsh web` process per environment on its own port. Each process owns its Sessions, workspaces and identities; a single `ssh-environments` settings section can describe every server, and each process selects one entry by id.

## Resume the same Session from another computer

The Session owner is the running `dsh web` process, and the Session log stays on that machine. Attach a second computer by forwarding the Web UI's port over SSH rather than starting another server:

```sh
ssh -L 3080:127.0.0.1:3080 you@harness-host
```

Open `http://127.0.0.1:3080` on the second computer and open the same Session; both clients derive the conversation from the same append-only event log, so the history and every later event converge. Either client may send a prompt: submissions are serialized through the Session inbox and both clients see the same conversation. A client that disconnects does not stop the Session or a running turn. The Web UI binds loopback deliberately: an all-interfaces bind is rejected, so a tunnel is the supported way to reach it from another machine.

## What stays local

The agent loop, model transport, approvals, Session storage, settings and the SSH connection itself run on the machine that started `dsh`. Only filesystem, process, terminal, LSP and sandbox work cross the connection. The changed-files summary is host-backed: its snapshot baseline canonicalizes the working directory on the harness host, so an SSH workspace's card lists file-tool edits only. The `@` file-reference picker is host-backed for the same reason: it scans the harness host, so it does not offer remote files.

## Sandbox behavior

Sandbox modes keep their meanings. `read-only`, `workspace-write` and `danger-full-access` are resolved on the remote host, which applies its own installed file-effect backend, and a remote host without one fails closed rather than running unfenced. A partial backend stays partial, and neither digest verification nor file-effect confinement makes a hostile remote host safe.

## Credentials

Credentials never reach the Session log, a conversation message, model context or another client. The environment registry stores references only, and settings redaction owns anything a client could read back.
