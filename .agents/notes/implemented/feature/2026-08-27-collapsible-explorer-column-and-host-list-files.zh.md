# Agent Note：可折叠文件浏览器列与 host.listFiles

状态：已实现

[English](2026-08-27-collapsible-explorer-column-and-host-list-files.md) | 中文

## 问题

Web GUI 此前没有任何项目文件浏览手段：文件引用要么经查看器打开，要么交给操作系统默认应用，而要发现一个路径只能让 agent 打印它。workspace 能力已经拥有文件侧的服务面（`readFile`、`openPath`、`listDirectory`），却从未组合成一个常驻导航表面；布局外壳右侧也只有详情与查看器两个占位列。

## 决策

两个动作，各管一个平面：

**Host API。** `host.listFiles({path?})` 以与 `host.readFile` 相同的路径接入 apiproxy 领域对象、wire schema 与 fetch 客户端：返回一层混合目录（`FileListingEntry {name, path, kind, hidden}`）、Host 端按名称排序、上限 1000 条并以 `truncated` 标记、符号链接类型在枚举时刻经 stat 探测解析。缺省路径列出进程 cwd——即默认项目根——因此客户端无需知道任何绝对起点。

**权限归类。** `listFiles` 走 loopback 方法围栏，与 `readFile` 并列，刻意绕开 directoryPicker 能力缝。picker 在 Windows 部署上解析为 native 提供者；若把浏览门控在一条在此平台上会解析成 "native" 的能力缝后面，等于发布一个在本会话所跑系统上自己都打不开的导航器。就侦察面而言，列目录结构与读内容同级：同一围栏，非 loopback 客户端同样是 `403`。

**客户端组合。** ui-layout 在会话栏与详情栏之间长出第五个子列，附带自己的窄轨契约（关闭时 44px、占用组件保持挂载、owner props 取自求解轨道）；求解器第 3 步先等右侧两个面板全部消亡，才让展开的浏览器列向中心地板收缩——随后自动收为窄轨，最后万不得已才允许中心跌破地板。新包 ui-file-explorer 按该契约懒加载注册：每展开一层拉取一次、缓存按路径保存并以响应回显的绝对路径为键（'' 是根请求哨兵）、逐层错误加重试、打开路由与 ui-conversation 共享“优先查看器”的回退。

默认列状态为关闭（偏好 0 ⇄ 默认 300px），保持装配启动输出字节稳定，折叠作为可选项。

## 后果

- `SlotMap` 新增 `explorer` 条目，AppFrame 渲染四条轨道；`ILayout.toggleExplorer()` 是唯一的展开/折叠入口；抽屉消费方未受影响。
- 常驻窄轨对每个宽视口收取 44px，即使偏好处于关闭态；接受为可发现性支付的价格（侧边栏早已付过）。
- 客户端展示排序（目录优先）必须持续与 Host 的分区内 locale 序一致；两端对同样的字符串排序，截断头窗口才能保持诚实。
- connection/test-runtime/fake-api 的替身都实现了 `listFiles`；未来任何消费方存根漏更新都会被 tsc 绊倒——这正是设计中的绊线。

## 备选方案

- **浏览门控在 directoryPicker 之后**——即上文否决理由：平台相关的失效风险。
- **Host 一次性下发整棵树**——否决：真实项目的深度与规模无界、无法增量探索、变更时重取风暴；层懒加载让成本与用户打开的范围成正比。
- **复用设置插件树组件**——否决：数据源不同（插件清单行 vs 文件系统层级）、交互目标不同（开关 vs 打开文件），“文件夹”的类比会把两个不相干表面耦合起来。
