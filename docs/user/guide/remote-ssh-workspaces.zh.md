# 通过 SSH 在远程主机上运行会话

[English](remote-ssh-workspaces.md) | 中文

[SSH 提供方族](../../../packages/ssh/README.zh.md) 在一台 POSIX 主机上运行文件、进程、终端与沙箱工作，而 Harness、其模型传输与会话存储仍留在你本机。本指南让 Web 会话的工作区落在该主机上，于是常规的 `read`、`write`、`edit`、`glob`、`grep`、`bash` 与终端工具都在远程运行，无需 `ssh`、`scp` 或任何 `remote_*` 工具。

## 前置条件

两端都必须运行 Linux 或 macOS。SSH 提供方拒绝其他任何客户端平台；本机 `ssh` 命令必须支持连接复用与 Unix socket 转发，服务器也必须允许该转发。

认证是非交互式的。连接启用 `BatchMode`、禁用 agent 转发、默认严格校验主机密钥，且不会弹出任何提示，因此请在启动前配置密钥或 SSH agent，以及 `known_hosts` 条目。

## 在远程主机上安装辅助程序

远程主机运行 `@deepseek-ai/dsh-ssh` 以 `./helper` 导出的辅助程序入口。该入口并非自包含：Node 会从它旁边解析其分块文件以及它导入的工作区包。请把构建好的辅助程序连同这些依赖安装到一个远程绝对路径下，置于工作区之外，也置于任何沙箱后端会替换的可写临时树之外，然后对入口取摘要：

```sh
shasum -a 256 /opt/dsh-ssh/helper.js
```

连接在辅助程序可用之前会校验该摘要，因此安装后被改动过的入口会拒绝连接。目前不提供自动置备、Windows 端点与自动重连。

## 命名 SSH 环境

```yaml
ssh-environments:
  environments:
    build01:
      label: Build 01
      host: build01.example
      user: alice
      identityFile: ~/.ssh/id_ed25519
```

把该小节保存到 `$DSH_HOME/settings.yaml`——目前没有 settings 卡片渲染它，请直接编辑文件；其 schema 与 id 到连接的解析由[环境注册表](../../../packages/ssh/ssh-environments/README.zh.md)负责。条目只存储连接引用——密钥路径、agent socket、配置文件路径——绝不存储密钥材料或口令。你省略的字段沿用 OpenSSH 自身的取值，因此其余连接细节可以留在 `~/.ssh/config` 中。

注册表注册 `ssh-environments` 命名空间，并把稳定 id 解析为经过校验的连接选项。Web 工作区选择器通过 `workspace.environments` 列出这些 id，远程工作区记录的是该 id 而非地址，因此重命名主机或远程目录不会改变工作区身份。

## 让 Web UI 面向远程主机启动

```sh
export DSH_SSH_ENVIRONMENT=build01
export DSH_SSH_NODE=/usr/bin/node
export DSH_SSH_HELPER=/opt/dsh-ssh/helper.js
export DSH_SSH_HELPER_HASH=<lowercase sha256 of that file>
export DSH_SSH_WORKSPACE=/home/alice/project
dsh web --patch /absolute/path/to/ssh-remote/cordis.yml
```

该覆盖层是 [`apps/cli/config/examples/ssh-remote/cordis.yml`](../../../apps/cli/config/examples/ssh-remote/cordis.yml)；开发检出可传入相对于仓库根目录的同一路径。它禁用本机文件系统、子进程与沙箱提供方，并挂载具名环境连接及其远程对应实现，因为两行不能注册同一个 `ctx.fs`、`ctx.subprocess` 或 `ctx.sandbox`。它还把默认的文件效果根指向 `DSH_SSH_WORKSPACE`。

不建立连接即可通过导出组合树来验证该组合：

```sh
dsh web --dump-config --patch /absolute/path/to/ssh-remote/cordis.yml
```

## 选择远程工作区

打开 Web UI 并选择一个工作区。选择器通过组合后的文件系统列目录，因此它一次只显示远程主机目录树的一层；OS 原生对话框绝不会出现，因为远程提供方报告 `addressesHostFilesystem: false`，而原生对话框只能返回主机路径。创建或选中项目目录、启动会话，文件浏览器、查看器与所有工具读取的都是同一个执行世界。

## 使用多台服务器

一份组合后的提供方族只服务一个 SSH 环境，因此第二台服务器需要第二份部署，而不是第二个工作区。为该服务器复制覆盖层，填入它自己的 `DSH_SSH_ENVIRONMENT`、`DSH_SSH_WORKSPACE` 与辅助程序坐标，并按环境各在一个独立端口上启动一个 `dsh web` 进程。每个进程拥有自己的会话、工作区与身份；同一份 `ssh-environments` settings 小节可以描述所有服务器，每个进程按 id 选择其中一个条目。

## 从另一台电脑继续同一个会话

会话所有者是正在运行的 `dsh web` 进程，会话日志留在那台机器上。接入第二台电脑的方式是经 SSH 转发 Web UI 的端口，而不是再启动一个服务器：

```sh
ssh -L 3080:127.0.0.1:3080 you@harness-host
```

在第二台电脑上打开 `http://127.0.0.1:3080`，并打开同一个会话；两个客户端从同一份只追加事件日志派生对话，因此历史与之后的所有事件都会收敛。两个客户端中的任何一个都可以发送提示：提交经会话 inbox 串行处理，双方看到同一段对话。断开的客户端不会终止会话或正在运行的一轮。Web UI 刻意只绑定回环：全网卡绑定会被拒绝，因此隧道是另一台机器访问它的受支持方式。

## 哪些留在本机

agent loop（智能体循环）、模型传输、审批、会话存储、设置以及 SSH 连接本身，都运行在启动 `dsh` 的那台机器上。只有文件系统、进程、终端、LSP 与沙箱工作跨越该连接。改动文件摘要由宿主支撑：其快照基线在 Harness 宿主上规范化工作目录，因此 SSH 工作区的卡片只列出文件工具的编辑。同理，`@` 文件引用选择器由宿主支撑：它扫描 Harness 宿主，因此不会提供远程文件。

## 沙箱行为

沙箱模式保持其含义。`read-only`、`workspace-write` 与 `danger-full-access` 在远程主机上解析，由该主机应用其自身已安装的文件效果后端；没有该后端的远程主机会失败关闭，而不是无围栏运行。partial 后端仍是 partial；摘要校验与文件效果围栏都不会让恶意远程主机变得安全。

## 凭据

凭据绝不进入会话日志、对话消息、模型上下文或另一个客户端。环境注册表只存储引用，任何客户端可能读回的内容都由 settings 脱敏负责。
