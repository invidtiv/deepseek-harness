---
description: "Web GUI 的外壳布局：五栏 AppFrame、拖动手柄与让步行为、面板几何服务与主题呈现；供窗口外观的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-layout

[English](README.md) | 中文

## 概述

本包提供 Web GUI 的五栏框架：侧栏、主面板区、浏览器列、文件查看器与右栏。各栏可拖动、可收起；窗口变窄时让步链保护中栏；`ctx.layout` 让其他插件选中主面板、切换侧栏或浏览器列、打开文件查看器并报告右栏的呈现形态。主题呈现器把解析后的配色方案、token 与正文字号投影到 document。需要标准窗口外观时选择它；面板几何是瞬时的，重新加载即重置。

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

在 root 槽位挂载本插件；它随即围绕占据侧栏、main、浏览器列、文件查看器与右栏的内容渲染应用框架。侧栏为 264～420px，默认 280px，收起后保留 56px 窄轨；窗口低于 1024px 时自动收起，打开右栏会丢弃手动展开的窄屏侧栏。右栏首次打开使用窗口宽度的 45%，之后保留用户像素偏好，上限为 70%。为保护中栏，框架先把右侧面板的轨道向其 300px 下限收缩，随后彻底移除轨道、令占用方从框架边缘悬于中栏之上，再收缩文件查看器并自动关闭，之后才允许已展开的浏览器列让步。拖拽跟手且无过渡延迟，关闭或全屏时不显示右栏拖拽区。

全局面板占据 root 作用域的 `main` keyed slot；`conversation` 是为会话界面保留的 key。`ctx.layout.selectPanel(id)` 选中已注册面板，`null` 则选中会话界面，但不改变当前会话。默认组合不注册任何全局面板。

### 主题呈现

呈现器消费解析后的主题快照，并投影到 document：`html { color-scheme }` 驱动原生 UA 控件，依据当前配色方案设置 `body[data-ds-dark-theme]`，把主题的别名 token 与 `--dsh-content-font-size` 设为 body 上的内联变量，并持有一个 `<meta name="theme-color">`，其内容随计算后的 body 背景色更新。释放呈现器时，它会连同其他全局写入一起移除自己的元数据节点。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`selectPanel(id)` 在改变选中态前检查实时 `main` 注册表；缺失的 key 会抛错并保留当前面板。`beginNavigation()` 为异步 UI 导航返回 abort signal。后续调用、有效面板选择（包括重复选择）或布局释放会中止该 signal，但不取消底层会话创建。消费者在提交导航或搬移草稿前检查 signal。

一次 `register()` 调用把 `AppFrame` 贡献进运行时的内建 `'root'` 槽位，并在同一刻声明六个子槽位（`sidebar`、`main`、`explorer`、`fileViewer`、`rightbar`、`shell.overlay`）、安放布局 store（面板几何）并接好 `ctx.layout` 面板动作服务。瞬时布局 store 以默认宽度启动侧栏、保持其余右列关闭，从不读写 `localStorage`。同一个 root 存储把 `panelInfo` 选中态与 `layoutInfo` 测量、宽度偏好、呈现报告分开。`usePanelInfo` 订阅引用稳定的选中态对象，AppFrame 订阅引用稳定的布局对象。AppFrame 始终挂载 main、浏览器列、文件查看器与右列，文件查看器抽屉在零宽度时保持其子树挂载。`rightbar` 的 owner 参数为实际 `width`、`viewportWidth` 与普通呈现的 `canShow`；占用方在空间不足时执行确定性的收起，变宽不自行重新展开。全屏隐藏宽度手柄，但不自行释放占用方要求保留的轨道。侧栏与浏览器列槽位接收框架的实时列状态（`collapsed` 取自求解后的窄轨宽度，因此求解器自动收起同样会渲染窄轨 UI，另有 `width`）；独立的标题组件仅在会话界面可见时使用所选会话标题，以构建配置的产品标题或本地化 `common.brand.localBuild` 为回退值；语言变化会更新该回退值。主题呈现器是第二个 effect：从解析后的快照做纯 DOM 写入——初始状态经 getter 读取一次，此后仅事件驱动，不经过 React。它先应用调色板、字号与 token 变量，再把渲染出的背景测量为唯一的颜色依据。全屏呈现禁用网格和手柄过渡；占用方完全覆盖框架后才报告新的列宽。退出全屏时，框架先保持无过渡并安装目标布局：关闭移除右轨道，恢复保留右轨道。后续普通几何操作恢复正常过渡。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当布局面不够用时阅读以下页面。它们从框架进入它所渲染的栏与它所呈现的主题。

- [ui-sidebar](../ui-sidebar/README.zh.md)——占据 `sidebar` 栏及其座位。
- [ui-file-explorer](../ui-file-explorer/README.zh.md)——占据 `explorer` 栏。
- [ui-conversation](../ui-conversation/README.zh.md)——占据 `main` 中的 `conversation` key。
- [ui-file-viewer](../ui-file-viewer/README.zh.md)——占据 `fileViewer` 栏。
- [ui-sidebar-right](../ui-sidebar-right/README.zh.md)——以每会话一个停靠面占据 `rightbar` 栏。
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

- **面板几何是瞬时状态**——重新加载会恢复侧栏默认值并保持右列关闭；每个拖出的宽度都是一份框架级偏好，不是按 Session 的事实。
- **极窄窗口**——右侧面板收起且文件查看器自动关闭后，中栏仍可能小于其下限；左侧 56px 控制栏保留。
- **让步链自动关闭通过推导零宽度实现，不触碰偏好宽度**——窗口变宽时面板自行恢复；消费方不得把 store 中存储的宽度当作渲染真值。
- **轨道与面板沿同一条曲线运动**——框架的轨道过渡和占位方的滑入读取同一组时长与缓动变量；占位方若自用一套，挤压时面板边缘就会与对话边缘脱开。
- **挤压重排期间无滚动锚定**——布局变化可能移动读者的视口。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。`ctx.layout` 后的 viewing-state store 不发出 Cordis 事件；clamp、让步链与轨道的时序由本包的 columns 与 service 规格直接断言。
