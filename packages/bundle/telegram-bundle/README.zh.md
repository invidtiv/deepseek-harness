---
description: "dsh Telegram 前端配置包：在 dsh-base 之上插入持久存储、workspace registry 与 dsh-telegram 行，供运行 Telegram 话题前端的部署使用。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-telegram-bundle

[English](README.md) | 中文

## 概述

dsh Telegram 前端配置包：[`cordis.patch.yml`](cordis.patch.yml) 在 `dsh-base` 之上插入持久存储三件套（`storage`/`storage-json`/`storage-domain`，即 web-app 配置包已有的三行）、workspace registry 与 [`dsh-telegram`](../../telegram/telegram/README.zh.md) 前端，本补丁层紧随 `dsh-base`。配置文件解析器通过 `dsh.bundle.patch` 清单字段解析该补丁；本包没有运行时 API。

## 目录

- [使用本配置包](#use-this-bundle)
- [模型体验](#model-experience)
- [已知限制与待完成工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-bundle"></a>
## 使用本配置包

`telegram` 行从环境缝隙读取部署值（沿用 base 配置包的 `DSH_PERMISSION_MODE` 惯例）：`DSH_TELEGRAM_TOKEN_REF`（凭证引用覆盖；令牌本身始终存放于凭证存储）、`DSH_TELEGRAM_ALLOWED_CHATS` 与 `DSH_TELEGRAM_ALLOWED_USERS`（逗号分隔的 id）、`DSH_TELEGRAM_WORKSPACE_ROOTS`（逗号分隔的绝对根目录）、`DSH_TELEGRAM_DEFAULT_WORKSPACE`，以及 `DSH_TELEGRAM_WORKSPACE_TOPICS_CHAT`（用于工作区话题创建的论坛超级群 id）。偏好静态配置的部署可在自己的补丁层覆盖 `telegram` 行；允许列表或根目录为空时插件加载即报错。与 headless 配置包一致，本包禁用了共享 HMR 行。

以 `dsh --profile telegram` 使用随附的配置模板启动，或在任意配置文件的 `dsh.profile.bundles` 中列出它。加入 Web profile 的配置包列表（base → web-app → telegram-bundle）后，插件还会注册 `telegram` 设置命名空间，浏览器插件 → 插件配置页会渲染其卡片。

-----

<a id="model-experience"></a>
## 模型体验

通过插入的行间接影响：本包决定挂载哪些前端、存储与工作区行，自身不贡献模型可见文本。

#### KV 缓存影响

无直接影响；每一插入行由其所属包负责。

## 已知限制与待完成工作

<a id="known-limitations-and-deferred-work"></a>

- **仅环境缝隙配置** — 本包不随附任何允许列表或根目录值；部署必须提供，或覆盖该行。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

本包不发布运行时不变量伴随模块；它是静态补丁清单载体（由其他包拥有的 loader 行组成的 YAML 文档）：不挂载服务、不发出事件、也没有可校验的可变关系。

</details>
