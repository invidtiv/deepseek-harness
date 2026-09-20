---
description: "DeepSeek Harness 的具名 POSIX SSH 环境注册表，由 settings 持久化"
kind: "package-reference"
---

# @deepseek-ai/dsh-ssh-environments

[English](README.md) | 中文

## 概述

`dsh-ssh-environments` 拥有部署中的具名 SSH 环境。它注册一个以稳定环境 id 为键的 `ssh-environments` settings 命名空间，并在 `ctx.sshEnvironments` 上暴露 `list`、`get`、`resolve` 和 `resolveRuntime`。每个条目提供某次 [SSH 提供方族](../README.zh.md) 部署所需的 OpenSSH 连接选项，并提供 helper 启动所需的远程运行时坐标——Node 可执行文件、已安装的 helper 入口、其摘要与远程默认工作区（条目省略时默认使用远程根目录）——使部署可以仅凭 settings 组合出该连接。注册表不打开连接、不存储密钥，也不贡献任何模型可见内容。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

Web bundle 会把本服务与 settings 提供方一同组合，因此插件设置页的 **SSH 环境**卡片可以定义这些 id；在服务器上执行文件的部署还会组合 [SSH 提供方族](../ssh/README.zh.md)，并在其中选用一个 id。在 `ssh-environments` settings 小节中配置环境：

```yaml
ssh-environments:
  environments:
    build01:
      label: Build 01
      host: build01.example
      user: alice
      identityFile: ~/.ssh/id_ed25519
      proxyJump: bastion
      node: /usr/bin/node
      helper: /opt/dsh-ssh/helper.js
      helperHash: <lowercase sha256 of that file>
```

[SSH 连接](../ssh/README.zh.md) 通过其 `environment` 配置字段按服务名读取该注册表，因此部署无需重复选项即可选择具名环境。`ctx.sshEnvironments.resolve(id)` 返回经过校验、已应用严格主机密钥检查与 10 秒、3 次探测保活的 `SshEnvironment` 连接选项。`ctx.sshEnvironments.resolveRuntime(id)` 在其之外还返回远程运行时坐标；OpenSSH schema 永远看不到这些运行时字段，条目缺少三个必需坐标之一都会抛出 `SshEnvironmentIncompleteError` 并列出缺失项，使部署在解析阶段失败而不是连接到猜测的位置；省略 `workspace` 的条目解析为远程根目录，选择器在那里打开以供操作者选择。未知 id 抛出 `SshEnvironmentUnknownError`；注册表绝不回退到默认主机。

<a id="model-experience"></a>
## 模型体验

无，因为注册表只保存部署连接配置且不打开连接；每项面向模型的操作均由消费方负责。

#### KV Cache 影响

本注册表不贡献请求前缀内容。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- **不支持交互式认证。** SSH 提供方启用 `BatchMode`；密码与口令提示不可用，因此部署须使用密钥或 SSH agent 认证。
- **单一扁平 settings 小节。** 环境存放在一个 settings 命名空间中，没有密钥槽位；未来的口令或令牌字段必须使用 `role('secret')`，让 settings 的 wire 脱敏将其移除。
- **settings 卡片每个环境只编辑两个字段。**[SSH 环境卡片](../../client/ui-settings-plugins/README.zh.md)通过客户端 settings-scope seam 绑定该命名空间，编辑每个环境的标识与 OpenSSH 目标；其余选项——`identityFile`、`identityAgent`、`proxyJump`、`configFile`、host-key 策略、超时，以及 `node`／`helper`／`helperHash`／`workspace` 运行时坐标——均原样写回，因此仍需来自 `$DSH_HOME/settings.yaml` 或 `~/.ssh/config`。
- **不拥有连接。** 注册表只解析选项；它从不打开、保活或重连连接。
- **无不变式伴随包。** 不发布运行时不变量伴随包，因为注册表不拥有独立的运行时状态：它读取一个 settings 命名空间并返回分离的值，所有持久关系由 settings 提供方自身的测试观察。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文 — 点击展开</summary>

环境条目携带的是连接引用（密钥路径、agent 套接字或配置文件路径），绝不是密钥材料或口令。由于连接启用了 `BatchMode`，密码认证保持不可用；未来的密钥槽位必须在 settings schema 上声明 `role('secret')`，让 wire 脱敏将其移除。

</details>
