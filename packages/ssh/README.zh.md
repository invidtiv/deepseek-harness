---
description: "POSIX SSH 提供方家族：共享连接、远端文件系统、托管子进程及文件效果沙箱。"
kind: "package-group"
---

# ssh/ — POSIX 远端执行提供方

[English](README.md) | 中文

## 概述

本家族将文件、普通进程、终端及沙箱执行放在 POSIX SSH 主机上，Harness 保留在本地。共享 OpenSSH 连接与已安装辅助程序支持现有文件系统、子进程及沙箱接口；需要访问多台主机的部署会在世界路由器之后为每个环境各组合一个连接。请在自定义 profile 中用本家族替换本机提供方——随附的覆盖层有单主机的 [`ssh-remote`](../../apps/cli/config/examples/ssh-remote/cordis.yml) 与多主机的 [`ssh-multi`](../../apps/cli/config/examples/ssh-multi/cordis.yml)——因为 `ctx.fs`、`ctx.subprocess` 与 `ctx.sandbox` 各自只能由一行注册。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

<a id="packages"></a>
## 包

| 包 | 职责 | 服务 |
|---|---|---|
| [`ssh`](ssh/README.zh.md) | 连接、辅助程序身份及传输生命周期 | `ctx.ssh` |
| [`fs-ssh`](fs-ssh/README.zh.md) | 远端文件身份、读取及带保护的原子修改 | `ctx.fs` |
| [`subprocess-ssh`](subprocess-ssh/README.zh.md) | 可执行文件查找、进程、控制流及终端 | `ctx.subprocess` |
| [`sandbox-ssh`](sandbox-ssh/README.zh.md) | 远端文件效果限制及执行信息 | `ctx.sandbox` |
| [`ssh-environments`](ssh-environments/README.zh.md) | 具名环境配置与 settings 拥有的注册表 | `ctx.sshEnvironments` |

<a id="related-documentation"></a>
## 相关文档

- [SSH 子系统](../../docs/subsystems/ssh.zh.md) — 共享执行坐标及传输归属。
- [POSIX SSH 决策](../../.agents/notes/implemented/architecture/2026-09-11-posix-ssh-runtime.zh.md) — 替代方案、影响及验证要求。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

远端能力实现保留共享异步终端及取消接口。绝不能从远端路径字符串推断本地路径访问能力。

</details>
