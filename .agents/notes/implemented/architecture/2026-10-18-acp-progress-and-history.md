# Agent Note: ACP progress and history

Status: implemented

English | [中文](2026-10-18-acp-progress-and-history.zh.md)

## Problem

Automation clients need retained conversation history and progress after reconnecting. Command acknowledgements alone cannot describe subsequent autonomous goal work, and task lists already have a durable representation.

## Decision

ACP projects existing goal and todo state without adding a second domain model. Standard assistant text carries current goal phase, activation, round count, and blocking reason; standard plan updates carry complete todo lists. Restoring a goal reports its disarmed state and does not restart work. V1 history loading and v2 replay use paged persistence reads and preserve conversation message identities.

This supersedes the history-loading and task-plan exclusions in [ACP as an automation-only protocol](../simplification/2026-07-23-acp-automation-only-protocol.md). [Command control](2026-10-17-acp-command-control.md) still owns command dispatch. Editor cards, plan-document review, terminals, and client filesystem access remain outside this transport.

Provider sharing uses the existing home patch layer. One complete adapter configuration serves every consuming profile; profile-local model selections and shared credential references remain independent. No implicit Web-profile import or second configuration store is introduced.

## Alternatives considered

A private goal protocol would require client-specific support for basic progress. Standard text works with existing clients, while the goal service retains structured state. Copying Web provider settings into ACP would leave two sources that drift; the home patch already supplies ordered shared configuration.

## Consequences

Clients receive goal updates independently of command completion. V1 load replays retained history, while resume restores current progress without transcript replay. Recorded-session and real-profile tests cover these distinctions; the T3 probe requires v2. Assistant output uses standard v2 chunks with stable message IDs because the tested generic runtime projects chunks into its event stream but omits whole-message replacements.
