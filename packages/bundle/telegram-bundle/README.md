---
description: "The dsh Telegram-frontend profile bundle: durable storage, the workspace registry, and the dsh-telegram row over dsh-base, for deployments running the Telegram topic frontend."
kind: "package-bundle"
---

# @deepseek-ai/dsh-telegram-bundle

English | [中文](README.zh.md)

## Summary

The dsh Telegram-frontend profile bundle: [`cordis.patch.yml`](cordis.patch.yml) inserts the durable storage trio (`storage`/`storage-json`/`storage-domain`, the rows the web-app bundle already ships), the workspace registry, and the [`dsh-telegram`](../../telegram/telegram/README.md) frontend over `dsh-base`, whose layer this patch follows. The profile composer resolves the patch through the `dsh.bundle.patch` manifest field; the package has no runtime API.

## Table of Contents

- [Use this bundle](#use-this-bundle)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-bundle"></a>
## Use this bundle

The `telegram` row reads its deployment values from environment seams (the base bundle's `DSH_PERMISSION_MODE` idiom): `DSH_TELEGRAM_TOKEN_REF` (credential-reference override; the token itself always lives in the credential store), `DSH_TELEGRAM_ALLOWED_CHATS` and `DSH_TELEGRAM_ALLOWED_USERS` (comma-separated ids), `DSH_TELEGRAM_WORKSPACE_ROOTS` (comma-separated absolute roots), `DSH_TELEGRAM_DEFAULT_WORKSPACE`, and `DSH_TELEGRAM_WORKSPACE_TOPICS_CHAT` (forum supergroup id for workspace-topic creation). A deployment preferring static config overrides the `telegram` row in its own patch layer; the plugin fails load while the allowlists or roots are empty. The bundle disables the shared HMR row like the headless bundle does.

Boot it as a shipped profile template with `dsh --profile telegram`, or list it in any profile's `dsh.profile.bundles`. Added to a Web profile's bundle list (base → web-app → telegram-bundle), the plugin also registers the `telegram` settings namespace, and the browser Plugins → Plugin configuration page renders its card.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the inserted rows: this bundle selects which frontend, storage, and workspace rows mount, and contributes no model-visible text of its own.

#### KV Cache effect

None directly; each inserted row's package owns its effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Environment-seam configuration only** — the bundle ships no allowlist or root values; a deployment must supply them or override the row.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No runtime invariant companion is published; the package is a static patch-list carrier (a YAML document of loader rows owned by other packages): it mounts no service, emits no events, and owns no mutable relation to check.

</details>
