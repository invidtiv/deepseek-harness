# Agent Note: Cordis inspect 提供方在各会话挂载之间共享

Status: implemented

[English](2026-09-12-cordis-inspect-provider-per-session-collision.md) | 中文

## 问题

在第二个并发会话中挂载 `cordis` agent preset 会失败，报错 `Host Cordis inspect provider "Service" is already registered`，并中止整个 preset 的挂载。因此，默认 agent preset 为 `cordis` 的部署，只要该 preset 上已有任一会话存在，**每一个**新会话都会失败，包括通过 Remote API 创建的会话。

该组合的两半对生命周期的理解并不一致。host 组合只挂载一次 `cordis-host-runner`，所以 `cordisInspect` 是进程级全局注册表。`cordis` agent preset 则每个会话挂载一次 `tool-cordis`，而该插件注册的四个提供方（`Service`、`Event`、`Builtin`、`Tool`）的 id 是固定的。注册表拒绝任何重复 id，于是首次挂载占用了这些 id，之后每次挂载都会抛错。

## 决策

`CordisInspectRegistryService.register` 按提供方 id 做引用计数。完全相同的 manifest 会取得既有条目的一个引用，并返回一个释放一个引用的 disposer；当最后一个持有者释放后，该条目消失。在一个已被持有的 id 下出现**不同**的 manifest 仍会快速失败，所以真正的冲突行为不变。每个 disposer 都是幂等的。

共享同一个条目是合理的，因为这些提供方描述的是进程级全局的 harness，而不是发起挂载的会话。`Service`、`Event` 和 `Builtin` 目录是对已生成声明的纯读取，实时的 `Tool` 提供方则从查询上下文解析*发起请求的* agent（`ctx.tools.schemas(context.agent)`），而不是从注册它的上下文解析。因此两次挂载给出的答案相同。

## 考虑过的替代方案

**在 host 组合中一次性注册这些提供方，让 `tool-cordis` 只负责查询。** 这是最干净的生命周期模型，但提供方的实现位于 tool 包内，并由该包生成的 API 目录构建，搬走它们会把自引用的工具集拆到 host 平面和 preset 平面，并改变已发布的组合。若将来 host 平面上出现第二个消费方需要该提供方目录，可重新考虑。

**按挂载为提供方 id 加命名空间。** inspect 工具按 id 寻址提供方，因此按挂载区分的 id 会出现在面向模型的目录中，并使 `cordis_inspect_query` 依赖恰好由哪次挂载作答。

**把重复注册当作由首次挂载拥有的静默 no-op。** 那么首次挂载释放时，就会删除其他仍在运行的挂载所需的提供方。

## 后果

多个会话可以同时运行 `cordis` preset，提供方目录对每个提供方 id 恰好保留一个条目，而真正的冲突仍会大声失败。注册表现在为每个提供方维护一个引用计数，从不释放的挂载会一直持有其引用——这正是预期的解读，因为提供方恰好在某个挂载持有时可用。

对未来提供方有一条约束：首次挂载的 handler 服务所有持有者，所以闭包捕获了按挂载状态的提供方不得与其他挂载共享同一个 id。目前每个提供方都是对 harness 的描述，agent 作用域的部分通过查询上下文传入。

## 测试

`packages/extensions/cordis-host-runner/tests/inspect-registry.spec.ts` 固定了相同 manifest 的共享、释放时的引用递减、幂等释放、最后一次释放后的重新注册，以及在一个已被持有的 id 下拒绝不同的 manifest。
