---
description: "Host 与 Client 工作区控制：修改工作区导航、为 Web GUI 读取文件，并跟随其完整投影。"
kind: "package-reference"
---
# Workspace Controller

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-api-workspace-controller` 拥有 Host 的 `ctx.workspaceController` 服务和生成的 Client `ctx.remote.workspace` namespace。它的 Remote 方法负责创建、重命名、移除和重排 Workspace，在 Workspace 内重排 Session，归档与取消归档 Session，为 Web GUI 的文件查看器与浏览器读取单个有界文本文件（`readFile`）、列出一个混合目录层（`listFiles`），以及跟随 Workspace 投影。当 Client 必须修改或跟随 Workspace 导航时，请通过 API 网关使用它。本包同时拥有 `ctx.directoryPickerController` 与生成的 `ctx.remote.directoryPicker` namespace，因为它承载的选目录 seam 是抽象的，自身从不作为 Loader entry。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Host 控制器会串行执行正确性取决于当前注册表状态的变更，并为预期失败抛出带有稳定 `workspace/*` 或 `directory-picker/*` 错误码的 `RemoteError`。它的 `follow()` 流会同步订阅持久 Workspace 变更，先发出一份完整 baseline，再按顺序发出 `upsert`、`remove`、`order` 和 `archived` 增量。重连会以替换 baseline 开始新一代，因此消费方不依赖收到断线期间的每个增量。

`readFile` 与 `listFiles` 动词由 `WorkspaceFileBrowse` 在组合文件系统上实现，因此 Web 文件浏览器与查看器读取的执行世界与 agent 工具相同：读取以 2 MiB 封顶并带截断标记、通过 NUL 字节检查拒绝二进制内容；列表在 1000 条上限内保留按名称排序的头部；缺省的列表路径在组合后的执行世界中解析为配置的默认项目根；当该世界无法读取宿主文件时退回到该世界的根。预期失败携带稳定代码（`file-not-found`、`file-unreadable`、`directory-unreadable`、`cancelled`）。`environments` 动词列出部署的具名 SSH 环境——即客户端可提供、远程工作区所记录的身份——未组合 `ssh-environments` 注册表时返回空列表。每条投影还会报告本部署是否为该环境组合了连接，因此 Web 工作区选择器会用环境声明的标签标注每个 Workspace，并为每个可访问世界各提供一个添加入口。若 create 指定的环境不可访问，则会被拒绝并返回 `workspace/unknown-environment`，而不会注册一个由其他主机服务的工作区。请求省略 `transport` 时，`create` 采用部署的执行世界，因此从客户端注册的工作区记录的是其目录实际解析所在的世界，而不是客户端的推测。

Client 入口提供 `ClientWorkspaceModel` 和 `createWorkspaceStateStream()`。该模型拥有 Workspace 行、registry 顺序、已归档 Session id、一元变更回显，以及流与一元调用的竞态处理。较新的 Host 行按 `updatedAt` 获胜；已提交的流顺序优先于较旧的一元响应；已经移除的 Workspace id 不会被延迟数据复活。该包公开与框架无关的快照和订阅，把导航策略与 React 钩子留给 UI owner。

-----

<a id="model-experience"></a>
## 模型体验

无，因为 Workspace 组织属于浏览器和 Host 的控制状态，并且不注册提示词、工具或会话事件。

#### KV Cache 影响

无直接影响；Workspace 变更不会改变模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- `follow()` 在重连后替换完整投影，不提供持久 cursor 或增量追赶协议。
- 进程内删除标记只会在 Client 模型生命周期内阻止延迟数据复活已移除的 Workspace。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。Workspace 注册表负责持久化，每次流生成都是完整投影。
