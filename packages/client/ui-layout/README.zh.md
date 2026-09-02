---
description: "Web GUI 的外壳布局：五栏 AppFrame、拖动手柄与让步行为、面板几何服务与主题呈现；供窗口外观的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-layout

[English](README.md) | 中文

## 概述

本包提供 Web GUI 的外壳布局：一个五栏 AppFrame，带可缩放的侧栏、浏览器列、详情面板与文件查看器面板；一条让步链，在空间不足时先收缩文件查看器、再收缩详情栏、随后把两者自动关闭——已展开的浏览器列要等右侧两个面板全部消亡后才会让步；以及 `ctx.layout` 面板几何服务，供其他插件调用以打开或关闭右侧面板并切换浏览器列。它还承载主题呈现器，把解析后的配色方案、别名 token、正文字号与 `theme-color` 元数据投影到 document。需要标准窗口外观时选择它；面板几何是瞬时的，重新加载即重置。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 root 槽位挂载本插件；它随即围绕占据侧栏、浏览器列、会话、详情栏与文件查看器栏的内容渲染应用框架。用户拖动不可见命中条带缩放侧栏、拖动各自的浮动胶囊缩放其余面板；窗口变窄时文件查看器先收缩，其次详情栏，随后两者自动关闭，之后已展开的浏览器列才会收缩。关闭的侧栏保留 56px 控制栏，关闭的浏览器列保留 44px 窄轨且其占用组件保持挂载，详情栏与文件查看器栏关闭到零宽度且保持挂载。

### 主题呈现

呈现器消费解析后的主题快照，并投影到 document：`html { color-scheme }` 驱动原生 UA 控件，依据当前配色方案设置 `body[data-ds-dark-theme]`，把主题的别名 token 与 `--dsh-content-font-size` 设为 body 上的内联变量，并持有一个 `<meta name="theme-color">`，其内容随计算后的 body 背景色更新。释放呈现器时，它会连同其他全局写入一起移除自己的元数据节点。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

一次 `register()` 调用把 `AppFrame` 贡献进运行时的内建 `'root'` 槽位，并在同一刻声明六个子槽位（`sidebar`、`conversation`、`explorer`、`details`、`fileViewer`、`shell.overlay`）、安放布局 store（面板几何）并接好 `ctx.layout` 面板动作服务。瞬时布局 store 以默认宽度启动侧栏、保持其余右列关闭，从不读写 `localStorage`。AppFrame 始终挂载会话、浏览器列与详情栏，文件查看器抽屉在零宽度时保持其子树挂载；已连接 Session 经 `SessionProvider` 渲染。它把所选 Session 标题投影到构建配置的产品标题或本地化 `common.brand.localBuild` 回退值之上，因此 locale revision 会随根 entry 一起更新文档元数据。侧栏与浏览器列槽位接收框架的实时列状态（`collapsed` 取自求解后的窄轨宽度，因此求解器自动收起同样会渲染窄轨 UI，另有 `width`）；主题呈现器是第二个 effect：从解析后的快照做纯 DOM 写入——初始状态经 getter 读取一次，此后仅事件驱动，不经过 React。它先应用调色板、字号与 token 变量，再把渲染出的背景测量为唯一的颜色依据。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当布局面不够用时阅读以下页面。它们从框架进入它所渲染的栏与它所呈现的主题。

- [ui-sidebar](../ui-sidebar/README.zh.md)——占据 `sidebar` 栏及其座位。
- [ui-file-explorer](../ui-file-explorer/README.zh.md)——占据 `explorer` 栏。
- [ui-conversation](../ui-conversation/README.zh.md)——占据 `conversation` 与 `details` 栏。
- [ui-file-viewer](../ui-file-viewer/README.zh.md)——占据 `fileViewer` 栏。
- [ui-theme](../ui-theme/README.zh.md)——呈现器消费其解析快照的主题 seam。
- [Web 客户端架构](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.zh.md)——浏览器插件行如何加载并注册槽位。

-----

<a id="model-experience"></a>
## 模型体验

无。布局外壳管理浏览器查看状态；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前布局行为。它们是当前包约束，不是通用窗口管理器对比或任务积压。

- **面板几何是瞬时状态**——重新加载会恢复侧栏默认值并保持右列关闭；在不同会话 id 之间切换同样会关闭详情栏并忘记拖动后的宽度，而未选中表面以零宽度渲染详情栏却不修改几何。
- **让步链自动关闭通过推导零宽度实现，不触碰偏好宽度**——窗口变宽时面板自行恢复；消费方不得把 store 中的详情宽度当作渲染真值。
- **挤压重排期间无滚动锚定**——布局变化可能移动读者的视口。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。`ctx.layout` 后的 viewing-state store 不发出 Cordis 事件；clamp、prune 与 concession-chain 顺序由本包测试覆盖。
