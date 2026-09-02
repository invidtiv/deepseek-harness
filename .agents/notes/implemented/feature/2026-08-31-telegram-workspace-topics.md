# Agent Note: Workspace creations drive Telegram forum topics

Status: implemented

English | [中文](2026-08-31-telegram-workspace-topics.zh.md)

## Problem

The Telegram frontend mapped topics to sessions in one direction only: a person creates the topic in Telegram and the plugin creates the session. A deployment running the Web GUI and the bot in one process had no way to surface web-created workspaces in Telegram — the workspace list and the topic list drifted apart, and the operator had to recreate every workspace as a topic by hand.

## Decision

A new `workspaceTopicsChatId` config field names the forum supergroup; absent keeps the feature off. The runtime constructor rejects a chat missing from a non-empty `allowedChatIds`, and `start` rejects a configured chat when the composition mounts no `ctx.workspaceRegistry` — both are misconfiguration, not features to skip silently.

`WorkspaceTopicBridge` (`src/workspace-topics.ts`) listens on `domain/changed` filtered to the `workspace` domain's `workspaces`-table `put`s. A creation write is recognized by `createdAt === updatedAt` on the registry entity; the registry commits its entity cache before the table write, so the lookup is current when the event fires. Two fences precede the Bot API call: the workspace path must pass the plugin's workspace-root guard by canonical containment, and a path already present as any mapping row's `workspace` or `pendingWorkspace` creates no duplicate. `createForumTopic` joins the `TelegramApi` wire surface, and the created topic's mapping row is written with `sessionId: null`, generation 1, and `pendingWorkspace` set to the workspace's canonical path, so the topic's first message opens its session in that workspace through the ordinary admission path. A Bot API failure logs ids and writes nothing.

## Alternatives considered

- **A dedicated workspace-created event on the workspace package**: rejected — `domain/changed` already publishes every durable write in write-chain order, and the `WorkspaceFeed` precedent reads workspace creation from it the same way; a parallel event would duplicate the authority.
- **Startup reconciliation creating topics for every unmapped existing workspace**: rejected for now — first enablement would flood the forum with topics for historic workspaces; the bridge covers live creations only, recorded as a Known Limitation.
- **Detecting creation by seeding known ids at start**: rejected — a seed racing the registry's asynchronous load can misclassify a later mutation as a creation, while `createdAt === updatedAt` is carried by the write itself.

## Consequences

- A deployment mounting the plugin beside the web app (whose composition already carries the workspace registry) turns the web workspace list into the Telegram topic list with one config value; the bot needs the `can_manage_topics` right in a forum-enabled supergroup.
- Workspaces created while the plugin is down get no topic, and a crash between the Bot API call and the mapping write leaves a topic whose first message falls back to the default workspace; both are documented package limitations.
- The Plugins settings card does not expose the field; the `telegram` settings section serves it, so composition entries and settings-document edits both apply live.

## Related

- [Telegram topic frontend Agent Note](../architecture/2026-08-20-telegram-topic-frontend.md) — the topic→session direction this note completes with the reverse mapping.
