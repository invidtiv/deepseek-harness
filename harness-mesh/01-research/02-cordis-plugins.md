---
description: "How to author a Cordis plugin in this harness: the two plugin forms, services, Config, effects, the exact files a new package must touch, and how profile bundles compose."
kind: "research"
---

# Cordis plugins: the authoring model this plan builds on

## A note on the word "cortix"

The request that produced this plan said "cortix plugins". There is **no such thing in this repository or in its dependency graph**: a case-insensitive grep for `cortix` across the checkout returns zero hits. A web search finds only unrelated projects — a Python network-simulation library and a Rust/WebAssembly spectrum-analysis library.

The plugin framework this harness uses is **Cordis**, vendored into `vendor/` and rescoped to `@deepseek-ai/cordis` (`vendor/README.md`). Everything below is the Cordis plugin model as this repository actually uses it. If "cortix" named something else to the reader, this section is the correction.

## The two plugin forms, and the rule that they never mix

| Form | Shape | Used for | Live example |
|---|---|---|---|
| Service / provider | `export default class X extends Service`, `constructor(ctx) { super(ctx, '<key>') }`, plus `declare module '@deepseek-ai/cordis' { interface Context { <key>: X } }` | A capability other plugins inject | `packages/ssh/ssh-environments/src/index.ts` |
| Function plugin | named `export const name`, `export const inject`, optional `export const Config`, `export function apply(ctx, config)`, and **no default export** | Tools, consumers, glue | `packages/todo/tool-todo/src/index.ts` |

Mixing the forms is the exact defect in `docs/postmortem/0001-acp-default-export-drops-inject.md`: the Loader's `unwrapExports` does `exports.default ?? exports`, so a stray `export default apply` replaces the module namespace with a bare function and **discards `inject`, `name`, and `Config`**. The plugin then runs in a fiber with no services and throws `cannot get property "agents" without inject` at load. Tests guard this by asserting `expect('default' in mod).toBe(false)`.

## Services, injection, and optional dependencies

- `ctx.provide(name, value)` registers a service and returns a disposer. `ctx.set(name, value)` only overwrites an already-provided service, and only from its providing fiber. The plugin-facing form is the `Service` base class.
- `inject` is a hard requirement: the fiber stays PENDING until the provider exists, and it unloads and reloads as the provider comes and goes.
- Optional capabilities use `ctx.get(name)`. Never the property proxy `ctx.<name>` for an undeclared service: the proxy is topology-sensitive, while `ctx.get` reads the global service store.

## Configuration

A plugin exports an `interface Config` and a Standard-Schema validator:

```ts
import z from '@deepseek-ai/schemastery'
export const Config: z<Config> = z.object({ /* ... */ })
```

Cordis validates before `apply`. Invalid config is a `ValidationError` and a FAILED fiber. A plain object named `Config` does not work — Cordis needs a validator, not a type.

The root convention is unambiguous: **no hardcoded tunables in plugins**. Every deployment-varying choice is a validated `Config` field changeable from `cordis.yml`. A `DEFAULT_*` constant or a test hook is not configurability. Protocol constants, external specs, and security invariants stay fixed.

## Effects, events, and hot reload

- **Registrations are effects.** Every contribution goes through `ctx.effect()` or `ctx.on()`, and a registry's `register()` returns the disposer. HMR reloads by unloading and reloading a fiber, so every registration must unwind cleanly.
- Dispatch modes: `emit` (observe, no return), `waterfall` (around-middleware; **a listener must call `next()`** or it short-circuits the chain), `parallel`, `serial`, `bail`.
- Typed events use declaration merging, and their JSDoc needs `@mode` plus a payload `@param` for each argument.

## The `!!js` tag, and exactly where it is allowed

`@deepseek-ai/cordis-plugin-include` parses `!!js` into expression nodes. The Loader interpolates **only**:

- an entry's `config`, after the entry's declared injections activate, evaluated against that plugin's context (`ctx.serviceName`), and
- an entry's `disabled`, at every mount decision, evaluated against the loader context.

All other metadata — `name`, `id`, `inject`, `group`, `isolate` — stays literal, so an expression there is just truthy data. This is why the shipped web patch writes `host: !!js ctx.webStartup.host ?? '127.0.0.1'` with `inject: [webStartup]` on the same row.

## The step-ordered recipe for a new in-repo package

1. **Create `packages/<group>/<pkg>/`** with `package.json`, `tsconfig.json`, `src/index.ts`, `README.md`, `tests/`. Choose an existing group where one fits; a new group is a bare container with no `package.json`.
2. **`package.json` invariants**, enforced by `scripts/check-workspace-constraints.ts`: name `@deepseek-ai/dsh-<name>`, `private: true`, version matching root, `"type": "module"`, `main: lib/index.js`, `types: lib/types/index.d.ts`, a `.` export with `types` then `default`, `@deepseek-ai/cordis` in **both** `peerDependencies` and `devDependencies` at the same range, every dsh peer mirrored into `devDependencies`, `@deepseek-ai/schemastery` in `dependencies`, and `files` listing exactly the emitted artifacts.
3. **Optional subpath exports**: `./invariant` only when the package owns a runtime relationship two independent observations can disagree about; `./client` for a browser half, which requires the `dsh.client` manifest block; `./typert` and `./remote` for a `ctx.remote` API, which also needs a `@deepseek-ai/dsh-typert-protocol` peer.
4. **`tsconfig.json`**: extends `tsconfig.base.json` (Client packages extend `tsconfig.base.client.json`), `rootDir: src`, `outDir: lib/types`, one `references` entry per workspace dependency, plus `../../runtime-diagnostics/invariants` only when publishing `./invariant`.
5. **Register in exactly one aggregate**: `{ "path": "./packages/<group>/<pkg>" }` in **either** `tsconfig.host.json` **or** `tsconfig.client.json`, never both. A brand-new group also needs a `./packages/<group>/*/src` candidate in the `@deepseek-ai/dsh-*` wildcard in `tsconfig.base.json` (regenerate with `pnpm run gen-tsconfig-paths`). `pnpm-workspace.yaml` already globs `packages/*/*`.
6. **Wire it into a composition.** For a Client plugin there are three required surfaces: the `tsconfig.client.json` reference, a row in `packages/bundle/web-app/cordis.patch.yml`, and a `packages/bundle/web-app/package.json` dependency. For a Host plugin the row belongs in `packages/bundle/base/cordis.patch.yml` or in a per-session preset under `packages/preset/agent-presets/presets/<preset>/agent.cordis.yml`.
7. **Resolver manifest.** `scripts/verify-cordis-config.ts` requires every bare plugin name in a `cordis.yml` to appear in that layer's resolver manifest `dependencies`: app overlays against `apps/cli/package.json` or a bundle manifest, each bundle patch against that bundle's own `dependencies`, package-owned Loader fixtures against that package's `dependencies` or `devDependencies`.
8. **README** with the gated sections: frontmatter `kind`, a `## Model Experience` section in the canonical format (or the declared no-effect variant), and `## Known Limitations and Deferred Work`.
9. **Verify**: `pnpm install`, `pnpm run doc-sync`, `pnpm run constraints && pnpm run typecheck && pnpm run lint`, `pnpm run build && pnpm run hygiene`. Client packages add `pnpm run test:gui`, and `DSH_SNAPSHOT=replay pnpm run test:web` when assembled UI output can change.

## Templates worth copying

| Need | Template |
|---|---|
| Function plugin: service + Config + model tool + tests | `packages/todo/tool-todo/` |
| Service package with Config | `packages/ssh/ssh-environments/` |
| Client UI plugin | `packages/client/ui-settings-unarchive-sessions/` (minimal), `packages/client/ui-workspace/` (complete) |
| Host + Client feature pair | `packages/schedule/schedule/` with `packages/client/ui-schedule/` |

## Bundles, profiles, and where a mesh row goes

A **profile** is a named composition under `$DSH_HOME/profiles/<name>`: an empty root `cordis.yml` plus ordered patch layers. Shipped templates live in `packages/boot/app-boot/src/profile.ts`; the Web profile is `web: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] }`.

Layer order, verified in `apps/cli/src/profile-boot.ts`: each bundle patch in order, then the profile's own `cordis.patch.yml`, then `$DSH_HOME/cordis.patch.yml`, then `--patch` overlays, then telemetry.

Entry forms:

```yaml
# Target an existing row by id. A patch REPLACES the whole config, so restate every key.
- id: message-feedback
  name: '@deepseek-ai/dsh-message-feedback'
  config:
    maxNoteBytes: 8192

# Keep a row but do not mount it.
- id: ui-schedule
  name: '@deepseek-ai/dsh-client-ui-schedule'
  disabled: true

# New rows go inside the bundle's single - insert: list.
- insert:
    - id: mesh
      name: '@deepseek-ai/dsh-mesh'
      config:
        port: 8737

# Expression forms: config (plugin ctx, after inject) and disabled (loader ctx) only.
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject: [webStartup]
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
```

Inspect a live tree with `dsh --profile web --dump-config`.

## Testing obligations a product-visible plugin inherits

- **Real-composition Loader boot test.** Hand-built `ctx.plugin(...)` suites are explicitly insufficient. Boot a test-only `cordis.yml` through the real Loader and Include, mock only external services or nondeterministic inputs, and assert model-visible, durable, or user-visible output. The model pattern is `packages/todo/tool-todo/tests/loader-composition.spec.ts`.
- **HMR/disposal proof.** Every registry contribution needs a test that disposes the contributing fiber and observes removal.
- **Coverage.** `pnpm run test:coverage` is the CI gate: per-file 100% on `packages/*/*/src`.
- **Specs run concurrently in forked workers.** Each spec owns its ports, paths, and child processes through teardown. A spec that passes only when run alone is a defect. This is directly relevant to a mesh plugin, which binds sockets.
