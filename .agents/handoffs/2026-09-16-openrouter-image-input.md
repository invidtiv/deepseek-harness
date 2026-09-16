# Handoff: let OpenRouter models accept image input

Status: open

## Objective

Make image input reachable and visible for models served over an OpenRouter pi-ai route, so a vision model can be selected and used from the product instead of only from a hand-edited `settings.yaml`.

## The gap

An OpenRouter route lists models through pi-ai discovery. OpenRouter's `GET /models` reply does disclose modality — the recorded fixture `packages/llm/llm-pi-ai/tests/fixtures/model-listings/openrouter-2026-09-02.json` carries `"architecture": { "modality": "text+image+file->text", "input_modalities": ["text", "image"] }` — but discovery drops it, and no settings surface can set it.

Two independent holes, either of which alone leaves a vision model text-only:

1. **Discovery discards the field.** `ListingEntry` (`packages/llm/llm-pi-ai/src/discovery.ts:72`) declares no `architecture`, and the row mapper (`:202-228`) copies only `id`, `name`, `contextWindow`, and `maxTokens`. The returned `LlmDiscoveredModel` (`packages/llm/llm/src/index.ts:594`) has no modality field to carry it in.
2. **No editor control.** `ModelListEditor` — the pi-ai and custom-provider editor — writes only `id`, `name`, `contextWindow`, `maxTokens` (`packages/client/ui-settings-models/src/client/ModelListEditor.tsx:147-150`). The pi-ai model field is `input`, not the DeepSeek adapter's `inputModalities`, and it is invisible and un-settable from the page that owns the array.

Why the pi-ai editor was left alone is already recorded in `.agents/notes/implemented/feature/2026-09-12-deepseek-catalog-image-input.md:19`: the two editors share `modelAdvanced` and the row layout but not the field name, the schema, or the inheritance rule. This handoff is that deferred work, scoped to OpenRouter.

### Effective modality today

`packages/llm/llm-pi-ai/src/catalog.ts:924` resolves one model's input as:

```
declaredInput(entry.input) ?? base?.input ?? [...request.defaultInput]
```

- `entry.input` — the configured model entry (`PiAiModelProfile.input`, `catalog.ts:599`); empty means "no answer".
- `base?.input` — the installed catalog entry.
- `request.defaultInput` — the route fallback (`config.ts:149`), schema default `DEFAULT_INPUT = ['text']` (`config.ts:79`, `:332`), and it may not be empty (`:450-452`).

OpenRouter's catalog entries and hand-declared entries therefore end at `['text']`, and a text-only route projects history with `projectTextOnlyImages` and refuses `read_image` with `does not declare image input`.

## The change

### Part A — carry modalities through discovery

- Add an optional modality field to `LlmDiscoveredModel` (`packages/llm/llm/src/index.ts:594`), typed `readonly ModelModality[]` so it matches `LlmModelInfo.inputModalities` (`:174`, `types.ts:325`). Document that absent means the endpoint disclosed nothing, per the existing "absent means unknown" convention.
- Declare `architecture` on `ListingEntry` and read both spellings: `input_modalities` first, then `modality`.
- Normalize into the **closed** vocabulary of `ModelModalityMap` (`packages/llm/llm/src/types.ts:218`) — only `text` and `image` exist. OpenRouter also reports `file`, `audio`, and `video`; drop them rather than widening the map. A `modality` string is `"<in>-><out>"`, so split on `->` and take the input half.
- `llm-pi-ai` is the **only** `registerModelDiscovery` producer (`packages/llm/llm-pi-ai/src/index.ts:260`), so no other adapter needs the field; it stays optional for any that arrives later.

### Part B — one control per row, mirroring the DeepSeek editor

- In `ModelListEditor`, add an Image input control inside the row's existing **Advanced** disclosure, beside the two capacity fields.
- Write the adapter's own two sets only — `input: ['text']` unchecked, `input: ['text', 'image']` checked — exactly as `DeepSeekModelsEditor.tsx:361-373` writes `inputModalities` via `IMAGE_CAPABLE_MODALITIES`. Do not author arbitrary sets: `['image']` is a route nobody asks for.
- Reuse the existing locale keys `modelImageInput` and `modelAdvanced` (`packages/client/ui-settings-models/src/client/locales.ts:53-54`; Chinese already at `:164-165`). The disclosure is already labelled Advanced in this editor.
- Preserve fields the editor does not show, as it does today, so a checkbox edit never drops a hand-set `reasoningEfforts`, `compat`, or `modelOverrides` entry.
- When `fetchModels` adopts a discovered row (`ModelListEditor.tsx:229-257`), seed the new entry's `input` from the discovered modalities instead of leaving it unset.

### Decide explicitly: per-model, route default, or both

Part B fixes "correct or declare one model". It does not fix a route whose every model is vision-capable, which the `defaultInput` JSDoc (`config.ts:140-148`) already describes as the intended one-place declaration. Ask before adding a route-level `defaultInput` control to `CustomProviderCard` — that is a second schema and a second editor surface, and the DeepSeek note's "Alternatives considered" rejects bundling an untested second schema into one change.

## Acceptance

- A `models` entry with `input: ['text', 'image']` on an OpenRouter route makes `read_image` answer against that model, and a route left at `defaultInput: ['text']` still refuses.
- The row's checkbox reflects and edits an inherited value: a catalog row carrying image input can lose it, and a text-only row can gain it.
- Discovery from the recorded OpenRouter fixture yields `inputModalities` containing `image`, and a listing without `architecture` yields the field absent rather than `[]`.
- Both bilingual README and docs pairs stay consistent.

## Verification

```sh
pnpm exec vitest run packages/llm/llm packages/llm/llm-pi-ai packages/client/ui-settings-models
pnpm run typecheck
pnpm run lint
pnpm run test:docs
pnpm run test:web        # the models-settings and onboarding goldens re-record here
```

Update in the same change:

- An Agent Note under `.agents/notes/implemented/feature/`, cross-linked to `2026-09-12-deepseek-catalog-image-input.md`, whose "pi-ai editor deliberately unchanged" paragraph it supersedes in part. Run the supersession check required by `.agents/notes/AGENTS.md`.
- The affected expected snapshots under `apps/web/tests/expected/models-settings/`, `models-settings-recovery/`, and `onboarding-*` if the row's accessible name or layout moves.
- `packages/llm/llm-pi-ai/README.md` and `packages/client/ui-settings-models/README.md` (with their `.zh.md` and `.i18n.yaml` records via `pnpm run verify-translation-pairing --write`).

## Constraints

- A model claiming images its endpoint refuses is refused by the provider mid-turn — this is a declared claim, never a probe (`catalog.ts:594-597`). Do not add a capability check.
- `PiAiModality` is derived from pi-ai's own `Model<Api>['input']`; keep the new mapping total over it rather than casting.
- Do not change `DEFAULT_INPUT`. Making images the route default would silently widen every text-only route.
