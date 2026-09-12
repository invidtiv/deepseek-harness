# Agent Note: DeepSeek catalog rows declare image input

Status: implemented

English | [中文](2026-09-12-deepseek-catalog-image-input.zh.md)

## Problem

The direct DeepSeek adapter ships image-capable catalog entries: `deepseek-flash` (V41 Flash) and `deepseek-v4-flash-vision-exp` declare `inputModalities: ['text', 'image']`, which is what selects the route's request-image budgets, the Files API upload path, and route pricing. The Models settings page could not express or display that field. Its DeepSeek catalog editor wrote `id`, `name`, and the two capacities only, while the settings section replaces `models` as one value — an array field has no per-entry fallback to the adapter default. A user who owned that array therefore had no product path to declare image input, and no way to see that a row had lost it.

The failure mode is silent until a request carries an image. A text-only route projects durable history through `projectTextOnlyImages`, replacing each image with a placeholder, and the `read_image` tool refuses with `does not declare image input`. A carried-over catalog pinning `inputModalities: ['text']` on an image-capable flash model leaves the model blind with no page-level signal.

## Decision

Each DeepSeek catalog row's disclosure carries one **Image input** checkbox beside the two capacity fields. Checked writes the adapter's `['text', 'image']`, unchecked its `['text']`; the editor writes only those two sets, so the control cannot author a catalog value the adapter rejects. Rows keep their arbitrary hidden fields, as before, so a checkbox edit never drops a description or a hand-set request budget.

The disclosure was labelled **Capacities**; it now holds a non-capacity field, so it is labelled **Advanced** in both editors that share `modelAdvanced`.

The pi-ai and custom-provider editor (`ModelListEditor`) is deliberately unchanged. Its model field is `input`, not `inputModalities`, and its route carries a `defaultInput` that a model entry inherits, so the same problem does not exist there in the same form; the symmetric control is deferred rather than duplicated under a different schema.

## Alternatives considered

**A multi-select over arbitrary modality sets.** The adapter accepts any non-empty, duplicate-free subset of `text` and `image`, so a general control would be the faithful one. No shipped catalog entry and no consumer distinguishes anything but text-only from text-and-image, and a set editor invites authoring `['image']`, a route no user asks for. One boolean over the two real catalogs is the smaller true control.

**Leaving the field YAML-only and fixing the user's document.** The editor already preserves fields it does not show, so hand-editing `settings.yaml` works and remains supported. It does not fix the discoverability gap: a row's image capability would still be invisible and un-settable from the product surface that owns the array.

**Adding the control to the pi-ai editor in the same change.** The two editors share `modelAdvanced` and the row layout, but not the field name, the schema, or the inheritance rule. Bundling an untested second schema into this change would widen the review for no coverage of the reported gap.

## Consequences

Image capability for a DeepSeek catalog row is now visible and editable wherever the row is. A user's text-only override can be repaired in place instead of by hand-editing the settings document, and a newly added row starts text-only until the box is set — the adapter's own default.

The image request budgets (`imagePixelBudget`, `imageMaxBytes`), `systemPromptUpdate`, and `description` stay YAML-only, unchanged by this control; the disclosure now mixes one boolean with two capacities, which is why its label moved from a field name to **Advanced**.

Package component tests cover both directions on inherited rows (an image-capable row losing image input, a text-only row gaining it) and a newly added row declaring image input before the write. The bilingual pair's golden aria snapshot for the expanded DeepSeek row and the two collapsed-row snapshots that carry the shared label were re-recorded with the new control.
