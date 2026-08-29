# Agent Note: In-app file viewer drawer with a Markdown reader mode

Status: implemented

[English](2026-08-27-file-viewer-drawer.md) | 中文

## 问题

在 Web GUI 中点击任何文件引用——聊天中的行内代码提及、产物文件标签或工具行的文件链接——都会把路径交给宿主原生打开器（`session.openWorkspacePath`），由其转交系统默认应用。浏览器随即失去上下文：文件在 harness 之外打开，不留痕迹；而在没有为该扩展名注册处理程序的机器上，点击毫无用处。

GUI 此前无法在页面内展示文本文件。代码与 Markdown 是本仓库最主要的产物类型，因此一个能同时渲染两者的查看器——代码走源码视图，Markdown 走渲染文档视图——覆盖了绝大多数不离开会话的阅读需求。

## 决策

新增客户端插件包 `@deepseek-ai/dsh-client-ui-file-viewer` 拥有右侧文件查看器抽屉；布局（`ui-layout`）拥有其列。

- **宿主 RPC `workspace.readFile`**（Workspace Controller 的 Remote 动词）读取单个文本文件，上限 2 MiB，并通过 NUL 字节启发式拒绝二进制内容，返回 `{ path, content, size, truncated, binary }`。缺失路径以 `file-not-found` 失败；目录或不可读目标以 `file-unreadable` 失败。读取上限的实现方式是最多多读一个字节，因此在证明截断的同时不会加载无界文件。
- **`ui-layout` 新增 `fileViewer` 列**，位于 `details` 之后（引入时为第四列；后来的[浏览器列](2026-08-27-collapsible-explorer-column-and-host-list-files.zh.md)位于会话栏与详情栏之间，不改变此处顺序）。两个右侧面板相互独立；让步求解器先把文件查看器收窄到其最小值（它最靠外且通常最宽），再收窄 details，随后先自动关闭文件查看器、再关闭 details。关闭时该列保持零宽挂载。
- **`ctx.fileViewer` 暴露 `open(path)`/`close()`。** 打开时写入 `loading` 过渡并打开该列，随后把结果折叠为 `ready`/`error`；请求序号守卫会丢弃快速重开或读取中关闭产生的过期读取。一个根作用域 store 持有唯一的活动文件与抽屉的渲染模式。
- **点击路由保持可选服务语义。** `ui-chat` 通过 `ctx.get('fileViewer')` 惰性读取：插件已组合时文件路径在抽屉中打开，目录以及未组合本包的部署保留系统打开器。移除本包即可为零调用方改动地恢复旧行为。
- **Markdown 阅读模式。** 已就绪的 `.md`/`.mdx` 文档在抽屉头部提供“渲染/源码”切换（`role="switch"`）。渲染视图走 ui-primitives 的已定稿 GFM+KaTeX 管线（`MarkdownText`，与聊天消息相同的渲染器，含围栏复制按钮）；源码视图显示普通行号高亮。打开其他文件或关闭抽屉时模式重置为源码；重新打开同一路径的 Markdown 文件恢复原模式。二进制拒绝时不提供切换。在读上限处被截断的文档在渲染视图中可能从块中间结束；元数据行在该视图中保留截断标记。
- **高亮复用 ui-primitives 的 shiki 高亮器**（公开再导出的 `highlightLines`），token 颜色保持在 `--shiki-*` 主题 token 上。

## 备选方案

**扩展抽屉自己的高亮器来渲染 Markdown，而非复用 `MarkdownText`。** 更轻量的自定义管线可以省去 KaTeX 与流式机制，但会在聊天与查看器之间分叉 GFM 行为，并重复 ui-primitives 已拥有的引用/脚注处理。复用已定稿管线不需要额外打包（动态模块表本就携带 primitives 行），并保持唯一的 Markdown 行为。

**把查看器作为现有 details 面板的一个标签页而非独立列。** details 是按会话的选中项检查状态；把原始文件查看混入其中会把两种不同的生命周期耦合在一起，还迫使求解器的单一 details 宽度同时约束两者。独立的列让两个面板各自保有宽度。

**让 `openFile` 的调用方自行选择目的地。** 要求每个产生文件链接的地方决定“查看器还是系统”会把策略扩散到多个包。在 `ui-chat` 注入门面内部经惰性可选服务查找统一路由一次，使回退自动发生并由组合驱动。

## 后果

经由 Workspace Remote 动词读取任意宿主文件确实扩大了可达数据面，但该请求与所有其他 `/api` 调用一样经过浏览器信任围栏，并把数据返回页面而不是把路径交给外部；2 MiB 上限与二进制拒绝限制了到达 DOM 的内容。接近上限的截断文件仍会逐行渲染——虚拟化留待真实使用形态需要时再做。抽屉是单一的全局界面：在一个会话打开文件会替换另一个会话正在显示的文件。

## 测试

覆盖率随包交付：store 过渡与模式持久化、控制器请求守卫与能力流转、组件的切换/渲染/源码行为、apply 接线与弃置证明、共享的 Markdown 谓词，以及更新为四轨的 layout 列测试和接好 `workspace.readFile` 的 connection/runtime fixture 客户端。
