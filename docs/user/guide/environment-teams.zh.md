---
description: "配置独立的 DSH Web 实例，使其参与分布式团队。"
kind: "user-guide"
---

# 跨机器分布式团队

[English](environment-teams.md) | 中文

## 概述

每台机器运行一个 DSH Web 实例，并配对需要交换工作的实例。此实验功能会在显式映射的本地检出目录中创建独立队友 Session。先配置一个协调端和一个工作端，再扩展到全部五台机器。

## 目录

- [准备各台机器](#prepare)
- [配对环境](#pair)
- [运行团队](#run)
- [开发备注](#dev-note)

<a id="prepare"></a>
## 准备各台机器

使用此分支的检出目录，先运行 `pnpm install`，再运行 `pnpm run build`。每台机器分别保留自己的 DSH 主目录、提供方凭据和仓库检出目录。如果此安装必须与另一个 DSH 安装共存，请将 `DSH_HOME` 设为私有绝对目录。

在启动 DSH 的 shell 中设置这些环境变量。Windows PowerShell 使用 `$env:NAME = 'value'`；Linux shell 使用 `export NAME='value'`。

| 变量 | 值 |
|---|---|
| `DSH_ENVIRONMENT_LABEL` | 便于阅读的机器标签 |
| `DSH_TEAM_PROVIDER` | 此实例中已配置的提供方 ID |
| `DSH_TEAM_MODEL` | 该提供方可用的模型 |
| `DSH_TEAM_PRESET` | 已安装的本地智能体预设，例如 Web 中的 `standard` |
| `DSH_TEAM_SANDBOX` | 初始 `read-only`、`workspace-write` 或 `danger-full-access` 限制 |
| `DSH_TEAM_APPROVAL` | 初始 `ask` 或 `never` 审批策略 |
| `DSH_TEAM_WORKSPACE` | 映射到 `project` 的已存在绝对检出目录 |
| `DSH_TEAM_PEERS` | JSON 对等端数组；首次未配对启动时可省略 |

从检出目录根目录，使用附带的覆盖层启动构建后的插件：

```sh
pnpm dsh web --patch apps/cli/config/examples/environment-team.yml --no-open --port 3000
```

`http://127.0.0.1:3000/.well-known/dsh/environment` 上的描述符返回持久化的 `environmentId`。在每台机器本地记录此值。将身份文件与该安装的其余状态一同保留；新机器需要新身份。

对于 tailnet 访问，[Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) 可以把私有 HTTPS 端点转发到环回服务器。配置端点以访问端口 3000，并将其 HTTPS 来源保存为对等端 URL。通过该主机名访问浏览器时，还需提供 DSH 的常规 `--trusted-host <hostname>` 选项和操作员身份验证。对等协议使用独立凭据。

<a id="pair"></a>
## 配对环境

为每一对协调端和工作端生成至少 32 字节的随机密钥，并在两个进程中通过选定的环境变量私密配置，例如 `DSH_PEER_WORKER_ONE`。每对使用不同的密钥。将协调端的 `DSH_TEAM_PEERS` 设为 JSON 数组，每个工作端对应一项：

```json
[{"environmentId":"11111111-1111-4111-8111-111111111111","url":"https://worker-one.example.ts.net","tokenEnv":"DSH_PEER_WORKER_ONE","workspaces":["project"]}]
```

用工作端记录的值替换示例 UUID 和主机名。在工作端使用相同的配对密钥配置协调端的 UUID 和 HTTPS 来源。两端分别将 `project` 映射到自己的本地检出目录。更改授权后重新启动两个 DSH 进程。JSON 中包含密钥变量名，不包含密钥值。

一个协调端加四个工作端的星形拓扑需要四组配对。工作端之间的消息经过团队协调端。如果另一台机器也需要领导团队，请为其将要访问的主机配置授权。对等端不可用时，消息保持排队；身份不匹配或缺少工作区授权会拒绝操作。

<a id="run"></a>
## 运行团队

在协调端配置的检出目录中打开 Session。要求它使用 `environment_list`，通过 `environment_team` 创建具名工作端，为该工作端提供自包含任务，并交换消息以及检查修订号的任务更新。每个工作端都会在其所属机器的 Web UI 中显示为普通本地 Session。使用 `environment_team` 的 `list` 操作读取团队状态。

排队结果确认工作已持久接纳，不代表执行或任务完成。请在检出目录之间显式交换 Git 提交或补丁。移除对等授权并重启后，后续对等请求会被拒绝；如需停止已授权的活动工作，应单独发出中断请求。

<a id="dev-note"></a>
## 开发备注

[包参考](../../../packages/experimental/environment-team/README.zh.md) 负责说明协议、授权、存储和资源限制。自动化证据覆盖开发机器上的隔离环回主机与录制的模型输出。混合 Linux/Windows 的 Tailscale 部署需要在实际机器群上验证。
