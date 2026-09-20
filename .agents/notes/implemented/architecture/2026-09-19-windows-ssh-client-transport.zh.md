# Agent Note: Windows SSH client transport

Status: implemented

[English](2026-09-19-windows-ssh-client-transport.md) | 中文

## Problem

[POSIX SSH 执行提供方](2026-09-11-posix-ssh-runtime.zh.md) 通过一个 OpenSSH 控制主连接（`ssh -M -S`）承载远端辅助程序，并用 `-O forward` 控制命令为每条程序流添加转发。该客户端传输在 Windows Harness 主机上不可用：Win32-OpenSSH 不实现控制主连接复用，`ssh -M -S` 会以 `getsockname failed: Not a socket` 失败，因此 Windows 部署根本无法组合 SSH 提供方族。远端辅助程序、摘要校验与提供方契约本身是可移植的；不可移植的只是客户端一侧的流传输。

## Decision

`SshConnection` 依据运行平台选择客户端传输。`internals.platform` 是可注入的 seam，因此测试可以在任意主机上验证任一条分支。在 Linux 与 macOS 上控制主连接保持不变。在 Windows 上，辅助程序由普通的 `ssh -T` stdio 会话承载（`buildDirectArgv`），每条程序流则开启一个专用的无命令 OpenSSH 会话，把本地回环端口转发到辅助程序预留的远端套接字（`buildForwardArgv`：`ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:<port>:<remote>`）。客户端预留一个临时回环端口，重试 TCP 连接，直到转发方接受连接或请求截止时限到期，并在流关闭或连接卸载时终止该会话。转发方不得携带 `ClearAllForwardings=yes`，因为该选项会清除这个会话存在意义所在的转发。

回环只绑定 `127.0.0.1`，流端点仍由同一个 TLS-PSK 能力令牌认证，因此这次改动只是把字节从本地 Unix 套接字改走一段回环 TCP，并未削弱流认证。远端辅助程序主机仍须运行 Linux 或 macOS。

## Alternatives considered

**在远端主机上运行 Harness。** 这正是 [POSIX SSH 决策](2026-09-11-posix-ssh-runtime.zh.md) 已经否决的部署模型：它把模型凭据、Session 存储与插件状态一并搬走，而不是提供可移植的客户端传输。

**用 WSL 充当 SSH 客户端。** WSL1 可以提供带控制主连接复用的 POSIX `ssh`，但 Harness 便依赖一个可能缺失或无法启动的虚拟机或转换层；WSL2 还需固件虚拟化。产品必须能在启动 `dsh` 的主机上运行。

**让所有平台统一使用回环传输。** 只有一条代码路径、没有平台分支，但每条 POSIX 流都会额外启动一个 `ssh` 进程并重新认证。控制主连接已在一条已认证连接上复用多条流，因此常见路径保留更快的传输。

**在 Windows 上实现复用。** Win32-OpenSSH 不实现 `ControlMaster` 或 `ControlPath`，没有可针对的客户端开关或命名管道替代方案。

## Consequences

Windows 上的每条流多付出一个 `ssh` 进程和一次回环 TCP 连接。端口预留与进程启动并非原子操作，因此连接会重试直到成功；`requestTimeoutMs` 为这段等待设限。释放流时改为终止其转发方，而不是发出 `-O cancel`。提供方族现在可运行于 Windows、macOS 与 Linux Harness 主机，而远端辅助程序主机仍须为 POSIX。

## Verification

`packages/ssh/ssh/tests/direct-transport.spec.ts` 通过 `internals.platform` seam 在任意主机上驱动 Windows 分支：启动参数、回环转发与释放、转发方退出、始终不绑定导致的超时、无法读取的预留地址、调用方取消，以及连接卸载。POSIX 生命周期套件继续钉住控制主连接分支。实机验收从 Windows 主机对 POSIX 辅助程序运行真实连接：摘要校验、远端目录列举、两条转发的流，以及一个远端 `/bin/sh` 进程及其退出观察。
