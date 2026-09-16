# dsh-ah-bridge — Android Harness 原生控制（可安装配置包）

[English](README.md) | 中文

从任意 DSH 会话都能原生、无需 CLI 地控制 LDPlayer Android harness：宿主组合注册 **44 个 `ah_*` 模型工具**，它们直接经 ADB 使用 `android-harness/1` RPC 协议通信（`adb shell content call --uri content://com.androidharness.agent.rpc`），不使用 `ahctl`，不做 shell 解析，输入输出均为结构化 JSON。

## 工具覆盖范围

| 分组 | 工具 |
| --- | --- |
| 设备清单 | `ah_devices`（ADB 设备 + harness 版本 + root 检查） |
| 运行时探测 | `ah_status`、`ah_version`、`ah_doctor`、`ah_context`、`ah_capabilities`、`ah_environment` |
| 事件 | `ah_events`（最近事件 + 持久化历史） |
| 插件／包 | `ah_plugins`、`ah_packages` |
| 控制 | `ah_target`、`ah_app`（launch/stop/clear/status）、`ah_daemon`（harnessd status/restart） |
| 诊断工具 | `ah_tools_list`、`ah_tool_call`、`ah_tool_describe` |
| 工作流／skill（技能） | `ah_workflows`、`ah_workflow_describe`、`ah_workflow_run`、`ah_skills` |
| 产物 | `ah_artifacts`、`ah_artifact_get`、`ah_artifact_read`（分片 base64）、`ah_artifact_delete`、`ah_pull`（adb pull） |
| 快照 | `ah_snapshot_capture`、`ah_snapshots`、`ah_snapshot_get`、`ah_snapshot_diff` |
| 会话 | `ah_session`（new/active/list/get/timeline/resume/pause/close）、`ah_session_observe`、`ah_session_bookmark`、`ah_session_export`、`ah_task` |
| 模型提供方 | `ah_providers`、`ah_provider_models`、`ah_provider_set_model`、`ah_provider_configure`、`ah_provider_test` |
| 设备端 agent | `ah_agent`（start/status/cancel/pause/resume）、`ah_agent_message` |
| 设备 shell | `ah_shell`、`ah_root_shell` |
| 逃生口 | `ah_rpc`：任意 harness RPC 方法 |

每个工具都接受一个可选的 `device` ADB 序列号；未提供时，会自动解析出一个粘性默认设备（确定性地取在线设备中序列号最小者）。长时间操作带有分钟级超时，超时后会终止整个进程树。

## 环境要求

- 一个通过 **profile** 启动的 DSH 部署（`dsh --profile <name>`；该 profile 位于 `${DSH_HOME:-~/.dsh}/profiles/<name>`，其中包含 `package.json`、`pnpm-workspace.yaml` 与 `cordis.patch.yml`）。
- harness 宿主机 PATH 上的 `adb`（任何能连上该模拟器的 adb）。
- 干净安装路径所需的 `pnpm`（没有它时，直接复制 `node_modules` 的回退方案同样可用）。
- 设备上运行的 Android 侧 harness 应用（HarnessRpcProvider）；本插件则是该 RPC 面的宿主侧一半。

## 安装（自动）

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

安装程序是幂等的（升级 `index.js` 后可安全重跑）：它把 `packages/dsh-ah-bridge` 复制进该 profile，添加 workspace 条目与 `dsh-ah-bridge: workspace:*` 依赖，把 `ah-bridge` insert 行追加到 `cordis.patch.yml`，运行 `pnpm install`（无 pnpm 时回退为直接复制），并验证模块导入以及完整的 patch 栈组合。

## 安装（手动）

1. 把 `packages/dsh-ah-bridge/` 复制到 `<profile>/packages/dsh-ah-bridge/`。
2. 在 `<profile>/pnpm-workspace.yaml` 的 `packages:` 下添加 `  - packages/*`。
3. 把 `"dsh-ah-bridge": "workspace:*"` 添加到 `<profile>/package.json` 的 dependencies 中，并在该 profile 中运行 `pnpm install`（或把包目录直接复制到 `<profile>/node_modules/`）。
4. 把 `patch-snippet.yml` 合并进 `<profile>/cordis.patch.yml`。

然后**重启 harness profile**：用户 patch 层在启动时挂载（随发行版交付的 web 配置包禁用了 HMR（热模块替换）服务，因此没有实时热重载）。之后进行验证：任意会话中都会出现 `ah_*` 工具，且启动日志包含 `ah-bridge: registered 44 Android-harness tools`。

## 管理

- **临时禁用**：向 `cordis.patch.yml` 添加（位于 insert 之后）：
  ```yaml
  - id: ah-bridge
    disabled: true
  ```
- **升级**：替换 `packages/dsh-ah-bridge/index.js`，重跑安装程序（或直接复制），重启该 profile。
- **移除**：从 `cordis.patch.yml` 删除 insert 块、删除 `packages/dsh-ah-bridge` 目录以及 `package.json` 依赖，然后重启。

## 故障排查

- *"No online ADB devices"*：启动 LDPlayer；检查 `adb devices` 是否返回处于 `device` 状态的模拟器。
- *"adb exited …"*：PATH 上的 adb 不对，或设备离线；每个工具也都接受显式的 `device` 序列号。
- 导入检查失败：确认该 profile 的 `node_modules/dsh-ah-bridge` 可解析（在 profile 目录中运行 `node --input-type=module -e "import('dsh-ah-bridge')"`）。
- 组合检查失败：确认 `cordis.patch.yml` 是顶层 YAML 数组；缺少目标的条目会在启动时记录一条逐条目 Loader 警告。
- `@deepseek-ai/dsh-tools` 无法解析：插件以对等依赖（peer dependency）方式导入它；任何 DSH 部署都会把它随附在共享的 `profiles/node_modules` 回退树中。

## 验证环境

本插件针对 `~/.dsh/profiles/web` 处的部署开发并验证（DSH `android-harness/1` RPC；设备应用版本 0.1.3）。该插件逻辑最初作为动态 Cordis 插件运行（44 个工具，端到端传输冒烟测试），随后作为这一静态宿主行运行，工具集相同。
