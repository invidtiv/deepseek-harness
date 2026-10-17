# Agent Note: ACP command control

Status: implemented

English | [中文](2026-10-17-acp-command-control.zh.md)

## Problem

ACP clients need deterministic control of persisted goals. Sending `/goal` as ordinary model input spends a model request and leaves execution to model interpretation even though the shared profile already mounts the command and goal services.

## Decision

ACP exposes the receiving Agent's registered commands through standard discovery and text prompt dispatch. Existing command handlers own validation, domain mutations, and durable command records. The bridge delivers direct text results without inserting command text into model history. This supersedes only the command exclusion in [ACP as an automation-only protocol](../simplification/2026-07-23-acp-automation-only-protocol.md); that note still owns transport and presentation restrictions.

Command completion and goal completion are separate. Commands can control a goal while its Agent runs; automatic rounds retain normal Agent cancellation and teardown. V2 reports autonomous activity and uses live-only message identities for command echoes and results. Command records remain durable but these echoes are not replayed.

## Alternatives considered

**Keep commands model-mediated.** This cannot provide deterministic inspection, pause, or mutation without spending a model turn.

**Restore the interactive UI bridge.** Goal control needs command dispatch and text results; editor cards, pickers, and Harness presentation metadata add responsibilities without serving this requirement.

**Implement goal parsing inside ACP.** Reusing the command registry preserves the same grammar and domain checks across clients.

## Consequences

ACP gains direct goal control while domain behavior remains in its existing owners. Registered slash prefixes now invoke commands, so clients discussing those commands with the model must embed them within ordinary prose. Command requests accept text only; attachments fail before execution. Protocol tests cover goal mutations, automatic rounds, cancellation, concurrent control, resume, and teardown; the shipped-profile snapshot pins direct goal output.
