# dsh-ah-bridge — Android Harness Native Control (installable bundle)

English | [中文](README.zh.md)

Native, CLI-free control of the LDPlayer Android harness from any DSH session:
the host composition registers **44 `ah_*` model tools** that speak the
`android-harness/1` RPC protocol directly over ADB
(`adb shell content call --uri content://com.androidharness.agent.rpc`) —
no `ahctl`, no shell parsing, structured JSON in/out.

## What the tools cover

| Group | Tools |
| --- | --- |
| Device inventory | `ah_devices` (ADB devices + harness version + root check) |
| Runtime probes | `ah_status`, `ah_version`, `ah_doctor`, `ah_context`, `ah_capabilities`, `ah_environment` |
| Events | `ah_events` (recent + persisted history) |
| Plugins / packages | `ah_plugins`, `ah_packages` |
| Control | `ah_target`, `ah_app` (launch/stop/clear/status), `ah_daemon` (harnessd status/restart) |
| Diagnostic tools | `ah_tools_list`, `ah_tool_call`, `ah_tool_describe` |
| Workflows / skills | `ah_workflows`, `ah_workflow_describe`, `ah_workflow_run`, `ah_skills` |
| Artifacts | `ah_artifacts`, `ah_artifact_get`, `ah_artifact_read` (chunked base64), `ah_artifact_delete`, `ah_pull` (adb pull) |
| Snapshots | `ah_snapshot_capture`, `ah_snapshots`, `ah_snapshot_get`, `ah_snapshot_diff` |
| Sessions | `ah_session` (new/active/list/get/timeline/resume/pause/close), `ah_session_observe`, `ah_session_bookmark`, `ah_session_export`, `ah_task` |
| Model providers | `ah_providers`, `ah_provider_models`, `ah_provider_set_model`, `ah_provider_configure`, `ah_provider_test` |
| On-device agent | `ah_agent` (start/status/cancel/pause/resume), `ah_agent_message` |
| Device shells | `ah_shell`, `ah_root_shell` |
| Escape hatch | `ah_rpc` — any harness RPC method |

Every tool accepts an optional `device` ADB serial; without one, a sticky
default is auto-resolved (deterministically the lowest serial among online
devices). Long operations carry minutes-scale timeouts with process-tree
termination on overrun.

## Requirements

- A DSH deployment booted through a **profile** (`dsh --profile <name>`; the
  profile lives at `${DSH_HOME:-~/.dsh}/profiles/<name>` with `package.json`,
  `pnpm-workspace.yaml`, and `cordis.patch.yml`).
- `adb` on the harness host's PATH (any adb able to reach the emulator).
- `pnpm` for the clean install path (a direct `node_modules` copy fallback
  works without it).
- The Android-side harness app (HarnessRpcProvider) running on the device —
  this plugin is the host half of that RPC surface.

## Install (automated)

```powershell
# Windows — into the "web" profile of the default DSH home:
.\install.ps1
# or a differently named profile / explicit directory:
.\install.ps1 -ProfileName cli
.\install.ps1 -ProfileDir C:\Users\me\.dsh\profiles\web
# checks only, no edits:
.\install.ps1 -VerifyOnly
```

```bash
# Linux/macOS:
./install.sh            # profile "web"
./install.sh -p cli     # differently named profile
```

The installer is idempotent (safe to re-run after upgrading `index.js`): it
copies `packages/dsh-ah-bridge` into the profile, adds the workspace entry and
the `dsh-ah-bridge: workspace:*` dependency, appends the `ah-bridge` insert row
to `cordis.patch.yml`, runs `pnpm install` (direct-copy fallback without
pnpm), and verifies the module import plus the full patch-stack composition.

## Install (manual)

1. Copy `packages/dsh-ah-bridge/` into `<profile>/packages/dsh-ah-bridge/`.
2. Add `  - packages/*` under `packages:` in `<profile>/pnpm-workspace.yaml`.
3. Add `"dsh-ah-bridge": "workspace:*"` to `<profile>/package.json` dependencies
   and run `pnpm install` in the profile (or copy the package folder directly
   into `<profile>/node_modules/`).
4. Merge `patch-snippet.yml` into `<profile>/cordis.patch.yml`.

Then **restart the harness profile** — the user patch layer mounts at start
(the shipped web bundle disables the HMR service, so there is no live hot
reload). Verify afterwards: the tools appear as `ah_*` in any session, and the
startup log contains `ah-bridge: registered 44 Android-harness tools`.

## Manage

- **Disable temporarily** — add to `cordis.patch.yml` (after the insert):
  ```yaml
  - id: ah-bridge
    disabled: true
  ```
- **Upgrade** — replace `packages/dsh-ah-bridge/index.js`, re-run the installer
  (or just copy), restart the profile.
- **Remove** — delete the insert block from `cordis.patch.yml`, the
  `packages/dsh-ah-bridge` folder, and the `package.json` dependency; then
  restart.

## Troubleshooting

- *"No online ADB devices"* — start LDPlayer; check `adb devices` returns the
  emulator in `device` state.
- *"adb exited …"* — wrong adb on PATH or device offline; every tool also
  accepts an explicit `device` serial.
- Import check fails — confirm the profile's `node_modules/dsh-ah-bridge`
  resolves (`node --input-type=module -e "import('dsh-ah-bridge')"` from the
  profile directory).
- Composition check fails — validate `cordis.patch.yml` is a top-level YAML
  array; a row missing its target logs a per-entry Loader warning at boot.
- `@deepseek-ai/dsh-tools` unresolvable — the plugin imports it as a peer; any
  DSH deployment ships it in the shared `profiles/node_modules` fallback tree.

## Provenance

Developed and verified against the deployment at `~/.dsh/profiles/web`
(DSH `android-harness/1` RPC; device app version 0.1.3). The plugin logic ran
first as a dynamic Cordis plugin (44 tools, end-to-end transport smoke test),
then as this static host row with the same tool set.
