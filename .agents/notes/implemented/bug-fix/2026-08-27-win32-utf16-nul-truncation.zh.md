# Agent Note: Win32 UTF-16 路径在原生文件夹选择器中被截断

Status: implemented

[English](2026-08-27-win32-utf16-nul-truncation.md) | 中文

## 问题

原生目录选择器绑定中的 `readUtf16` 扫描 COM `PWSTR` 的 NUL 终止符时只检查每个码元的**低字节**：`bytes[end] !== 0`。UTF-16LE 的 NUL 是两个零字节，因此任何低字节为零的 BMP 码元——即所有 U+XX00 字符，如「开」（U+5F00，字节 `00 5F`）、「一」（U+4E00）、「退」（U+9000）——都会被误判为字符串结尾。选择包含此类字符的目录时，返回的路径在该字符处被截断，随后的 `workspace.create` 因截断后的路径不存在而以 `workspace-invalid-path` 失败：Web GUI 弹出文件夹错误对话框，工作区无法添加。上游已报告为 [discussion #563](https://github.com/deepseek-ai/deepseek-harness/discussions/563) 与 [discussion #580](https://github.com/deepseek-ai/deepseek-harness/discussions/580)。

## 决策

`readUtf16` 只在两个字节均为零时终止扫描：`(bytes[end] !== 0 || bytes[end + 1] !== 0)`。单个零低字节是合法码元，扫描继续，因此包含 U+XX00 字符的路径会被完整读出。`koffi.view(address, 32768)` 的读取上限不变：该函数仍读取一个固定窗口，足以覆盖文件夹对话框可到达的所有路径；同样的两字节判定也会在窗口内的第一个真实终止符处正确停止。

## 验证

假 COM 套件（`win32-dialog-bindings.spec.ts`）新增一条用例，对话框路径为 `C:\选中\开目录`（U+5F00）：`runFolderDialog` 必须返回完整路径。修复前扫描返回截断前缀，该用例在旧扫描下为红、新扫描下为绿。本机全部 directory-picker 测试通过，包括真实 win32 打开并中止关闭的冒烟测试。运行对话框的构建产物 `lib/worker.cjs` 已重新构建，安装版消费者将获得修复；ESM 驱动包不受影响（字符串读取只存在于 worker 入口中）。

## 考虑过的替代方案

**保留只看低字节的扫描。** 对每个 U+XX00 路径都是错误的；截断是静默的，失败会在更晚处表现为令人困惑的 `workspace-invalid-path`。

**用 `koffi.decode(addr, 'str16')` 解码出参指针。** 在引入 `readUtf16` 时已被否决：出参是裸地址，把它当指针解码会在真实 Windows 上崩溃。直接查看内存的做法保持不变。

**扫描不断增大的窗口，使超过 16K 码元的路径也能存活。** 文件夹对话框实际上无法产生这样的路径，而无界读取 COM 拥有的内存会把理论上的截断换成内存错误风险；固定窗口保持不变。

## 后果

路径含 U+XX00 BMP 字符的文件夹可以被选择并注册为工作区。纯 ASCII 路径的行为与之前完全一致。无 wire、持久化或配置格式变更；无迁移。修复只涉及一个函数中的一个条件加一条回归测试，与 discussion #580 中提供的 cherry-pick 一致。
