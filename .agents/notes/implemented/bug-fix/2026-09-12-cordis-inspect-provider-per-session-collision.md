# Agent Note: Cordis inspect providers are shared across session mounts

Status: implemented

English | [中文](2026-09-12-cordis-inspect-provider-per-session-collision.zh.md)

## Problem

Mounting the `cordis` agent preset in a second concurrent session failed with `Host Cordis inspect provider "Service" is already registered`, which aborts the whole preset mount. A deployment whose default agent preset is `cordis` therefore failed **every** new session — including sessions created through the Remote API — as soon as one session on that preset existed.

The two halves of the composition disagree about lifetime. The host composition mounts `cordis-host-runner` once, so `cordisInspect` is a process-global registry. The `cordis` agent preset mounts `tool-cordis` once per session, and that plugin registers four providers (`Service`, `Event`, `Builtin`, `Tool`) whose ids are fixed. The registry rejected any repeated id, so the first mount claimed the ids and every later mount threw.

## Decision

`CordisInspectRegistryService.register` reference-counts by provider id. An identical manifest takes a reference to the existing entry and returns a disposer that releases one reference; the entry disappears when the last holder releases it. A **different** manifest under a held id still fails loud, so a genuine conflict is unchanged. Each disposer is idempotent.

Sharing one entry is sound because these providers describe the process-global harness rather than the mounting session. The `Service`, `Event`, and `Builtin` catalogs are pure reads of generated declarations, and the live `Tool` provider resolves the *requesting* agent from the query context (`ctx.tools.schemas(context.agent)`), not from the context that registered it. Two mounts therefore answer identically.

## Alternatives considered

**Register the providers once in the host composition and leave `tool-cordis` to query only.** This is the cleanest lifetime model, but the provider implementations live in the tool package and are built from its generated API catalogs, so moving them would split the self-referential toolset across the host and preset planes and change shipped compositions. Revisit if a second host-plane consumer needs the provider directory.

**Namespace provider ids per mount.** The inspect tools address providers by id, so per-mount ids would surface in the model-facing directory and make `cordis_inspect_query` depend on which mount happened to answer.

**Treat a duplicate registration as a silent no-op owned by the first mount.** The first mount to dispose would then delete a provider that other live mounts still need.

## Consequences

Several sessions can run the `cordis` preset at once, the provider directory keeps exactly one entry per provider id, and a real conflict still fails loudly. The registry now carries a reference count per provider, and a mount that never disposes keeps its references — which is the intended reading, since the provider is available exactly while some mount holds it.

One constraint follows for future providers: the first mount's handler serves every holder, so a provider that closes over per-mount state must not share an id with another mount. Today every provider is a description of the harness, and the agent-scoped part arrives through the query context.

## Testing

`packages/extensions/cordis-host-runner/tests/inspect-registry.spec.ts` pins identical-manifest sharing, reference release on disposal, idempotent disposal, re-registration after the last release, and rejection of a different manifest under a held id.
