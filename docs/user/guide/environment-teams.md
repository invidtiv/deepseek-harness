---
description: "Configure independent DSH Web installations to participate in distributed teams."
kind: "user-guide"
---

# Distributed teams across machines

English | [中文](environment-teams.zh.md)

## Summary

Run one DSH Web instance per machine and pair the instances that need to exchange work. This experimental feature creates independent teammate Sessions in explicitly mapped local checkouts. Start with one coordinator and one worker before extending to all five machines.

## Table of Contents

- [Prepare each machine](#prepare)
- [Pair environments](#pair)
- [Run a team](#run)
- [Dev Note](#dev-note)

<a id="prepare"></a>
## Prepare each machine

Use this branch's checkout and build it with `pnpm install` followed by `pnpm run build`. Keep each machine's DSH home, provider credentials, and repository checkout separate. Set `DSH_HOME` to a private absolute directory if this installation must coexist with another DSH installation.

Set these environment variables in the shell that launches DSH. Windows PowerShell uses `$env:NAME = 'value'`; a Linux shell uses `export NAME='value'`.

| Variable | Value |
|---|---|
| `DSH_ENVIRONMENT_LABEL` | Human-readable machine label |
| `DSH_TEAM_PROVIDER` | A provider ID configured in this instance |
| `DSH_TEAM_MODEL` | A model available from that provider |
| `DSH_TEAM_PRESET` | Installed local agent preset, such as `standard` in Web |
| `DSH_TEAM_SANDBOX` | Initial `read-only`, `workspace-write`, or `danger-full-access` confinement |
| `DSH_TEAM_APPROVAL` | Initial `ask` or `never` approval policy |
| `DSH_TEAM_WORKSPACE` | Existing absolute checkout directory mapped to `project` |
| `DSH_TEAM_PEERS` | JSON peer array; omit for the initial unpaired launch |

From the checkout root, launch the built plugin with the supplied overlay:

```sh
pnpm dsh web --patch apps/cli/config/examples/environment-team.yml --no-open --port 3000
```

The descriptor at `http://127.0.0.1:3000/.well-known/dsh/environment` returns the durable `environmentId`. Record it from each machine locally. Keep the identity file with the rest of that installation's state; a fresh machine needs a fresh identity.

For tailnet access, [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) can forward a private HTTPS endpoint to the loopback server. Configure the endpoint to reach port 3000 and retain its HTTPS origin as the peer URL. For browser access through that hostname, also supply DSH's ordinary `--trusted-host <hostname>` option and operator authentication. The peer protocol uses separate credentials.

<a id="pair"></a>
## Pair environments

Generate one random secret of at least 32 bytes for each coordinator/worker pair and install it privately in both processes under a chosen environment variable, such as `DSH_PEER_WORKER_ONE`. Use a different secret for every pair. Set the coordinator's `DSH_TEAM_PEERS` to a JSON array with one entry per worker:

```json
[{"environmentId":"11111111-1111-4111-8111-111111111111","url":"https://worker-one.example.ts.net","tokenEnv":"DSH_PEER_WORKER_ONE","workspaces":["project"]}]
```

Replace the sample UUID and hostname with the worker's recorded values. On the worker, configure the coordinator's UUID and HTTPS origin with the same pair secret. Each side maps `project` to its own local checkout. Restart both DSH processes after changing grants. The JSON contains secret variable names, never secret values.

A star topology needs four pairs for one coordinator and four workers. Worker-to-worker messages go through the team's coordinator. If another machine must lead teams, configure grants for the hosts it will address. An unavailable peer leaves delivery queued; a mismatched identity or missing workspace grant rejects the operation.

<a id="run"></a>
## Run a team

Open a Session in the coordinator's configured checkout. Ask it to use `environment_list`, spawn a named worker with `environment_team`, give that worker a self-contained task, and exchange messages and revision-checked task updates. Each worker appears as an ordinary local Session in its own machine's Web UI. Team state is available through `environment_team` with action `list`.

A queued result confirms durable admission. It does not confirm execution or task completion. Exchange Git commits or patches explicitly between checkouts. Removing a peer grant and restarting denies subsequent peer requests; interrupt authorized active work separately when needed.

<a id="dev-note"></a>
## Dev Note

The [package reference](../../../packages/experimental/environment-team/README.md) owns protocol, authorization, storage, and resource-limit details. Automated evidence covers isolated loopback hosts and recorded model output on the development machine. A mixed Linux/Windows Tailscale rollout requires validation on the actual fleet.
