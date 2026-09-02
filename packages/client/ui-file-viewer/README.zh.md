---
description: "Web GUI 的右侧文件查看器抽屉：ctx.fileViewer 门面、有界高亮读取与 Markdown 阅读模式，供应用内文件查看的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-file-viewer

[English](README.md) | 中文

## 概述

右侧文件查看器抽屉的归属包。它提供 `ctx.fileViewer` 门面（`open`/`close`）并把抽屉注册到 layout 所拥有的 `fileViewer` 列，因此点击文件引用——行内代码提及、产物文件标签或工具行的文件链接——会在可拖拽的右侧面板中打开文件内容，而不是交给系统默认应用。浏览器半边即整个插件；Node 半边是空的加载入口。

## 目录

- [控制器门面](#controller-face)
- [抽屉渲染](#drawer-rendering)
- [拦截归属](#interception-ownership)
- [信任围栏](#trust-fence)
- [模型体验](#model-experience)
- [已知局限与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="controller-face"></a>
## 控制器门面

`FileViewerController` 是跨插件门面：`open` 写入 `loading` 过渡并打开 layout 列，随后把宿主 `readFile` 的结果折叠为 `ready`/`error`。请求序号守卫会在快速重开或读取中关闭时丢弃过期读取。宿主读取是有界的（过大的文件返回截断前缀，非文本文件返回 `binary`），因此抽屉既不会把无界文件加载进 DOM，也不会渲染乱码。

-----

<a id="drawer-rendering"></a>
## 抽屉渲染

`FileViewer` 渲染抽屉的框架——含关闭按钮的“文件名 + 完整路径”头部、元数据行（语言、行数、大小、截断标记）以及可滚动正文。正文复用 ui-primitives 的 shiki 逐行高亮（即读卡器的路径），行号槽与带 token 着色的源码并排，未知或尚未加载的语言渲染为普通等宽字体，整个区域保留原生文本选择。活动文件为空（抽屉关闭）时渲染为空，同时列保持零宽挂载。

`.md`/`.mdx` 文档额外提供 Markdown 阅读模式：头部出现“渲染/源码”切换（`role="switch"`），渲染视图走 ui-primitives 的已定稿 GFM+KaTeX 管线（即聊天消息渲染器 `MarkdownText`，围栏复制按钮、安全链接与数学公式一并可用），源码视图则显示普通高亮源码。打开其他文件或关闭抽屉时模式重置为源码；重新打开同一路径的 Markdown 文件会恢复上次的模式。二进制拒绝时不提供切换。

-----

<a id="interception-ownership"></a>
## 拦截归属

拦截是调用方的选择，而非本包的行为：[ui-chat](../ui-chat/README.zh.md) 会先把点击路径按会话 cwd 解析，当 `ctx.get('fileViewer')` 可用时路由到 `open`，否则回退到宿主原生打开器（`session.openWorkspacePath`）。因此将本包从组合中移除后，每个文件链接都会恢复为“用系统默认应用打开”的旧行为，调用方无需任何改动。目录场景（“在文件夹中显示”）不是文件读取，始终保留宿主打开器。

-----

<a id="trust-fence"></a>
## 信任围栏

`readFile` 是普通的 workspace Remote 动词，不是特权端点：它与每个 `/api` 请求一样经过浏览器信任围栏（loopback、部署派生的 LAN 字面量或声明的受信任主机），被拒绝的请求会让抽屉显示其错误状态。契约见 [slot 系统标准](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.zh.md)。

-----

<a id="model-experience"></a>
## 模型体验

无，因为抽屉渲染的是浏览器已经打开的文件；本包没有任何内容进入模型请求。

#### KV 缓存影响

无；本包既不组装也不发送 provider 请求。

## 已知局限与待办

<a id="known-limitations-and-deferred-work"></a>

- **超大文件会把每一行渲染进 DOM。** 宿主读取上限为 2 MiB，但接近该上限的截断前缀仍有成千上万行；虚拟化（或客户端行数上限）留待真实使用形态需要时再做。
- **二进制判定是 NUL 字节启发式。** UTF-16 或其他不含 NUL 的非 UTF-8 文件可能被解码为替换字符而非被拒绝；更严格的检测留待后续。
- **抽屉是单一的全局界面。** 在一个会话中打开文件会替换另一个会话所显示的文件；按会话记忆活动文件留待后续。
- **截断的 Markdown 在阅读模式下可能从块中间断开。** GFM 管线只渲染收到的内容，2 MiB 前缀边界若落在围栏块内会将其隐式闭合；源码视图中的截断标记是权威信号，阅读视图会在元数据行保留该标记。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

本包不发布运行时不变量伴随模块；slot、词典、store 与服务注册均为 effect 所有，插件测试已证明其随 fiber 释放，包内没有位于这些 fiber 之外的可变状态。

</details>
