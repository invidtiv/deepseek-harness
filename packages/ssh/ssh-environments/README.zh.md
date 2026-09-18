---
description: "DeepSeek Harness 的具名 POSIX SSH 环境注册表，由 settings 持久化"
kind: "package-reference"
---

# @deepseek-ai/dsh-ssh-environments

[English](README.md) | 中文

## 概述

`dsh-ssh-environments` 拥有部署中的具名 SSH 环境。它注册一个以稳定环境 id 为键的 `ssh-environments` settings 命名空间，并在 `ctx.sshEnvironments` 上暴露 `list`、`get` 和 `resolve`。每个条目提供某次 [SSH 提供方族](../README.zh.md) 部署所需的 OpenSSH 连接选项；注册表不打开连接、不存储密钥，也不贡献任何模型可见内容。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

将本服务与一个 settings 提供方（例如 [`dsh-settings-file`](../../settings/settings-file/README.zh.md)）以及 [SSH 提供方族](../ssh/README.zh.md) 一同组合。在 `ssh-environments` settings 小节中配置环境：

```yaml
ssh-environments:
  environments:
    build01:
      label: Build 01
      host: build01.example
      user: alice
      identityFile: ~/.ssh/id_ed25519
      proxyJump: bastion
```

[SSH 连接](../ssh/README.zh.md) 通过其 `environment` 配置字段按服务名读取该注册表，因此部署无需重复选项即可选择具名环境。`ctx.sshEnvironments.resolve(id)` 返回经过校验、已应用严格主机密钥检查与 10 秒、3 次探测保活的 `SshEnvironment` 连接选项。未知 id 抛出 `SshEnvironmentUnknownError`；注册表绝不回退到默认主机。

<a id="model-experience"></a>
## 模型体验

无，因为注册表只保存部署连接配置且不打开连接；每项面向模型的操作均由消费方负责。

#### KV Cache 影响

本注册表不贡献请求前缀内容。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- **不支持交互式认证。** SSH 提供方启用 `BatchMode`；密码与口令提示不可用，因此部署须使用密钥或 SSH agent 认证。
- **单一扁平 settings 小节。** 环境存放在一个 settings 命名空间中，没有密钥槽位；未来的口令或令牌字段必须使用 `role('secret')`，让 settings 的 wire 脱敏将其移除。
- **尚无 settings 卡片。** 该命名空间已注册，并可通过 `settings.describe()` 发现，但目前没有任何 settings 卡片渲染它：在卡片通过客户端 settings-scope seam 绑定同一命名空间之前，请直接编辑 `$DSH_HOME/settings.yaml` 中的 `ssh-environments` 小节。
- **不拥有连接。** 注册表只解析选项；它从不打开、保活或重连连接。
- **无不变式伴随包。** 不发布运行时不变量伴随包，因为注册表不拥有独立的运行时状态：它读取一个 settings 命名空间并返回分离的值，所有持久关系由 settings 提供方自身的测试观察。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文 — 点击展开</summary>

环境条目携带的是连接引用（密钥路径、agent 套接字或配置文件路径），绝不是密钥材料或口令。由于连接启用了 `BatchMode`，密码认证保持不可用；未来的密钥槽位必须在 settings schema 上声明 `role('secret')`，让 wire 脱敏将其移除。

</details>
