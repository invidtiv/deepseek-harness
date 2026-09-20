---
description: "提示上下文：说明 Session 工作区所在的远端 SSH 执行世界"
kind: "package-reference"
---

# @deepseek-ai/dsh-execution-world-context

[English](README.md) | 中文

## 概述

`dsh-execution-world-context` 贡献一条运行时提示上下文，说明 Session 工作区所在的执行世界。当工作区注册在具名 SSH 环境上时，agent 会被告知其文件、进程与沙箱都在那台远端主机上运行，而不是在提供界面的这台机器上；由本机服务的工作区不贡献任何内容。该上下文按服务名读取工作区注册表与 `ssh-environments` 注册表，因此任一缺失时都能组合，且不依赖这两个包。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

只要部署中的工作区可能位于 SSH 世界，就挂载本行；它不需要任何配置。不提供工作区注册表、不提供环境注册表，或只有本地工作区时，它不贡献任何内容。

该上下文位于 `EXECUTION_WORLD` 运行时上下文次序，排在沙箱策略行之后、审批策略行之前。

<a id="model-experience"></a>
## 模型体验

### 执行世界感知

#### 模型看到的内容

当工作区注册的 transport 为 `ssh` 时，会增加一行运行时上下文。本地工作区、未注册的目录，或未组合可选注册表的部署都不会增加任何内容。

##### 远端工作区

```markdown
Your workspace /home/bsdev/BS/oculon lives in SSH environment "BSD dev" (bsdev). Files, processes and sandboxing execute on that remote host, not on the machine serving this interface.
```

#### Token 影响

只要 Session 的工作区位于远端，每次请求增加一行短文本；否则不增加。

#### KV Cache 影响

只要 Session 的工作区注册不变，该行保持稳定。

##### 稳定行

```markdown
The line stays inside the reusable request prefix while the workspace registration does not change.
```

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明执行世界行何时并不合适。它们是当前包约束。

- **只说明一台主机，不含拓扑。** 该行只指出环境名称，不列举可达主机、其中的路径，也不列举混合部署同时服务的本地回退世界。
- **无不变式伴随包。** 不发布运行时不变量伴随包：该上下文只读取两个注册表并渲染一个字符串，不拥有独立的持久或运行时关系。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
