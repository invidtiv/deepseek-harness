---
description: "Prompt context naming the remote SSH execution world a Session workspace lives in"
kind: "package-reference"
---

# @deepseek-ai/dsh-execution-world-context

English | [中文](README.zh.md)

## Summary

`dsh-execution-world-context` contributes one runtime prompt context naming the execution world a Session's workspace lives in. When the workspace is registered against a named SSH environment, the agent is told that its files, processes and sandboxing run on that remote host rather than on the machine serving the interface; a workspace served by this host contributes nothing. The context reads the workspace registry and the `ssh-environments` registry by service name, so it composes with either absent and depends on neither package.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount the row in any deployment whose workspaces may live in an SSH world; it needs no configuration. Give it no workspace registry, no environment registry, or only local workspaces and it contributes nothing.

The context is placed at the `EXECUTION_WORLD` runtime-context order, after the sandbox policy line and ahead of the approval policy line.

## Model Experience

### Execution-world awareness

#### What the model sees

One runtime context line is added for a workspace whose registered transport is `ssh`. A local workspace, an unregistered directory, or a deployment without the optional registries adds nothing.

##### Remote workspace

```markdown
Your workspace /home/bsdev/BS/oculon lives in SSH environment "BSD dev" (bsdev). Files, processes and sandboxing execute on that remote host, not on the machine serving this interface.
```

#### Token effect

One short line per request while the Session's workspace is remote, and no line otherwise.

#### KV Cache effect

The line is stable while the Session's workspace registration does not change.

##### Stable line

```markdown
The line stays inside the reusable request prefix while the workspace registration does not change.
```

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the execution-world line is a poor fit. They are current package constraints.

- **One host name, no topology.** The line names the environment; it does not enumerate reachable hosts, paths inside them, or the local fallback world a mixed deployment also serves.
- **No invariant companion.** No runtime invariant companion is published: the context reads two registries and renders a string, so it owns no independent durable or runtime relation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
