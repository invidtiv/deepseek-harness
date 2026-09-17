# Handoff: replicate multimodal `deepseek-flash` on another Harness

Status: open

## Objective

Make image input work with `deepseek-flash` on a target DeepSeek Harness, matching a deployment where it already works. This is a **configuration** task: no code change is required.

## Check this first — the answer may be "nothing to do"

`models` is `z.array(catalogModel).default(DEFAULT_MODELS)` (`packages/llm/llm-deepseek/src/config.ts:88`), and the shipped `DEFAULT_MODELS` entry for `deepseek-flash` already declares `inputModalities: ['text', 'image']` (`packages/llm/llm-deepseek/src/common/models.ts:11`).

So **if the target's settings do not set `llm-deepseek.models`, it is already multimodal.** Customizing that list is the only thing that can take it away, because a configured list replaces the shipped catalog wholesale — there is no per-entry merge back to the defaults.

Decide which case applies via the target's `settings.yaml` (`<DSH home>/settings.yaml`, default `~/.dsh/settings.yaml`; `packages/settings/settings-file/src/index.ts:57`):

- No `llm-deepseek.models` key → verify with the steps below, expect success, stop.
- `llm-deepseek.models` present → apply the change below.

## The change

Add `inputModalities` to the `deepseek-flash` row. Omit nothing else, and do not touch the other rows:

```yaml
llm-deepseek:
  models:
    - id: deepseek-flash
      name: DeepSeek-Flash
      description: Fast, efficient, and economical; suited to focused, routine, or parallel tasks.
      contextWindow: 1000000
      inputModalities:
        - text
        - image
      systemPromptUpdate: in-history
```

`1000000` is `DEFAULT_CONTEXT_WINDOW` and `in-history` mirrors the shipped row; both may already be present. Only `inputModalities` changes behavior.

The equivalent GUI path writes the same value: Models settings page → DeepSeek provider → the row's **Model options** disclosure → **Input types** → **Image** (`packages/client/ui-settings-models/src/client/ModelRow.tsx` renders the shared `ModelInputTypes` control, and the DeepSeek editor passes `inputField="inputModalities"`; it writes exactly `['text']` or `['text', 'image']`, so it cannot author a value the config rejects).

Confirm the target's catalog is not missing the row for a different reason — the shipped catalog is asymmetric, and a hand-written list must reproduce it:

| id | shipped `inputModalities` |
|---|---|
| `deepseek-flash` | `['text', 'image']` |
| `deepseek-v4-pro` | absent → `['text']` |

`deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are no longer shipped rows; a target whose `settings.yaml` still lists them is carrying a stale copy of a catalog that used to include them.

## Prerequisites

Three, all usually already satisfied:

1. **Credential** — `DEEPSEEK_API_KEY` in the target's credential store (env, `.env`, or `.credentials.yaml`). It is the default `apiKeyEnv` (`config.ts:13,82`).
2. **An attachment provider mounted** — `attachment-local` or any `ctx.attachments` provider. It ships in the `base` bundle (`packages/bundle/base/cordis.patch.yml:125`), so any profile built on `base` has it. The adapter reads it lazily at `packages/llm/llm-deepseek/src/index.ts:116`.
3. **The session's selected model is the row you edited.** `agent-default-model` seeds only *new* sessions; an existing session keeps its own selection. This is the most common reason a correct config still fails.

## Why one field is sufficient

`inputModalities` is the single switch behind four behaviors:

1. **Prompt admission** — `packages/api/session-controller/src/commands.ts:336-343` resolves the *session's* model and throws `session/attachment-invalid` with reason `MODEL_DOES_NOT_SUPPORT_IMAGES` unless the list contains `image`.
2. **Request-image budgets** — `config.ts:155-188` derives `imageMaxBytes` (defaulting from `DEFAULT_REQUEST_IMAGE_MAX_BYTES`) when `hasImage`, feeding `resolveRequestImageTarget` (`common/request-pricing.ts:53`).
3. **Upload path** — `protocols/messages/images.ts:39+` resolves each image ref into request bytes, bounds them (`maxRequestFilesBytes` for raw, `maxInlineRequestImageBytes` for base64), uploads through the DeepSeek Files API, and falls back to bounded inline base64 when an id stops resolving (`common/request-files.ts:14`).
4. **Pricing** — `common/request-pricing.ts:96` applies image pricing only when the row declares image.

`protocol` is unset by default → `messages` (`config.ts:81`), under which images are accepted **only in user messages and tool results** (`protocols/messages/images.ts:50-52`).

## Verify on the target

1. Attach a small PNG in a session whose selected model is `deepseek-flash`.
2. Expect the image to reach the model, and the prompt to show its sha256 plus a normalized read-only copy under `<DSH home>/attachments/v1/objects/<first2>/<sha256>`.
3. Ask the model to describe the image; it should describe its actual content.

### Failure signatures and what each means

| Symptom | Cause | Fix |
|---|---|---|
| "The current model does not support images; switch to a model that does" | The **session's** model resolves text-only | Select `deepseek-flash` in that session; or the row lacks `inputModalities` |
| "requires the durable attachment service" | No `ctx.attachments` provider in the profile | Mount `attachment-local` |
| Provider error mid-turn, after acceptance | The endpoint refuses images the row claims | Remove `image` from that row |
| Row silently text-only | The id is absent from the configured `models` list | Re-add it; uncatalogued ids are forced text-only |

The last row is a deliberate hard rule: `common/model-info.ts:70-74` refuses to guess for an uncatalogued model, because declaring an unverified image capability would let the host persist input the endpoint may reject on every later turn.

## Constraints

- **The declaration is a claim about the endpoint, never a probe** (`protocols/messages/images.ts` and the shipped catalog comments). Reproduce the shipped asymmetry; do not blanket-declare `[text, image]` across the list. That converts a clear up-front refusal into a mid-turn provider error.
- Row validation (`config.ts:144-173`): the list must be non-empty, duplicate-free, and contain only `text`/`image`; duplicate model ids are refused.
- A text-only row must not declare `imagePixelBudget` or `imageMaxBytes` — that throws `cannot declare image request limits` (`config.ts:156-158`).
- Do not edit the shipped `DEFAULT_MODELS` to fix one deployment; the supported path is the settings row or the GUI control.
