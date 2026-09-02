---
description: "Web GUI 的可折叠右侧文件浏览器列：逐层 Host 列表、展开缓存、经共享打开契约路由的文件行，供项目导航器的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-file-explorer

[English](README.md) | 中文

## 概述

可折叠的右侧文件浏览器列所有者。它将文件树注册到布局拥有的 `explorer` slot（`sidebar | conversation | explorer | details | fileViewer`），每个目录层对应一次 Host 列表：展开某行时通过 workspaces 接口的 `listFiles` 拉取该层，收起保留缓存以便即时重新展开，文件行的打开路径与其他一切可点击文件引用一致——组合了 `ctx.fileViewer` 时走抽屉，否则回退到宿主原生打开器（`session.openWorkspacePath`）。浏览器半部即整个插件；Node 半部是空的加载入口。

## 目录

- [列几何](#column-geometry)
- [列表行为](#listing-behavior)
- [信任围栏](#trust-fence)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="column-geometry"></a>
## 列几何

列几何属于 [ui-layout](../ui-layout/README.zh.md)：插件对着由求解轨道派生的 `collapsed`／`width` owner props 渲染。关闭状态收缩为 44px 窄轨，其上固定的文件夹标签点击后请求展开（经 `ILayout.toggleExplorer()`），展开态标题栏的折叠标签则反向请求。组件从不卸载，因此层级缓存、展开状态与选中高亮在同一次页面加载内跨越折叠往返保持不变。

-----

<a id="listing-behavior"></a>
## 列表行为

`FileExplorerRoot` 在客户端对每层排序：目录先于文件（两个分区内各自按 locale 序，与 Host 的名称排序一致），隐藏条目照常渲染，并为任何被 Host 限量截断的层级追加截断说明（1000 条列表上限）。失败按层隔离：某个不可读子目录只展示自己的就地重试，树的其余部分继续工作；根级失败则提供整页重试。

挂载时即使处于折叠态也会预热一次项目根目录，首次展开即可命中缓存而不是闪现加载态。

-----

<a id="trust-fence"></a>
## 信任围栏

`listFiles` 是普通的 workspace Remote 动词，不是特权端点：它与每个 `/api` 请求一样经过浏览器信任围栏（loopback、部署派生的 LAN 字面量或声明的受信任主机），被拒绝的请求会让各层显示各自的错误态。契约：[slot 系统标准](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.zh.md)。

-----

<a id="model-experience"></a>
## 模型体验

无。文件树读取的是用户目视浏览的目录名；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **暂无键盘树导航。** 每一行都是可通过 Tab 聚焦的按钮，但方向键遍历与对平铺按钮列表的即时输入定位等到真实使用压力出现后再做。
- **符号链接的类型只在列表时刻解析一次**——Host 在枚举时逐条 stat 探测，加载后又翻转的链接在该层重新拉取前保持旧类型。
- **选中高亮不跟随外部打开**——在聊天引用等其他入口打开文件不会更新本树的选中行。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

本包不发布运行时不变量伴随模块；slot 与词典注册均为 effect 所有，插件测试已证明其随 fiber 释放，目录列表经运行时的 workspaces 契约流动，包内没有位于这些 fiber 之外的可变状态。

</details>
