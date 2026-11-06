# Pi in Container · `pi-container`

在容器中运行原生 [Pi Coding Agent](https://github.com/earendil-works/pi)，通过 tmux 托管 Pi 进程，断开终端后接回同一进程，并管理开发容器与独立服务容器。宿主无需安装 Node.js 或 Pi。

项目仓库：[L4nterns/pic](https://github.com/L4nterns/pic)。Gateway 在公开仓库 [L4nterns/pi-provider-gateway](https://github.com/L4nterns/pi-provider-gateway) 独立维护，通过网络安装，不捆绑在本项目源码或镜像中。

## 职责与入口

**宿主唯一操作入口是 `pi-container`，无参数进入交互菜单。** 只额外接受 `-h` / `--help`，不提供子命令或 Pi 参数转发。项目不提供浏览器控制台、管理 HTTP API 或管理网站。

| 负责方 | 职责 |
| --- | --- |
| 原生 `pi` | 对话、`/new`、`/resume`、`/compact`、模型、思考档位、主题、provider 与插件 |
| `pi-container` | 容器生命周期、启动并托管进程、断开终端、接回原进程、明确结束进程 |

Pi 的 `--resume` / `--continue` 恢复磁盘历史，不是附着到另一个正在运行的 TUI；RPC 是程序控制接口。tmux 管理的是进程与终端连接，不替代 Pi 的对话功能。账号、路由和额度由上游管理。

## 安装

需要 Linux、Bash 4.1+、GNU coreutils、`flock`，以及有权限使用的本机 Docker Engine / Compose v2。部署功能另需宿主 OpenSSH 客户端。不支持远程 Docker Engine；WSL 使用 Linux 环境。

公开命令使用 `pi-container`，不占用 groff 的 `pic` 命令。安装脚本、宿主链接和 Shell PATH 由操作者管理。

以下步骤用于**全新安装**，不要覆盖已有 `.env`、配置、凭据或业务数据。本项目提供源码，不提供预构建镜像。

```bash
tar --same-permissions -xzf pic-source.tar.gz
cd pic
printf 'DEPLOY_DATA_DIR=\n' > .env

if [ "$(id -u)" = 0 ]; then BIN_DIR=/usr/local/bin; else BIN_DIR="$HOME/.local/bin"; fi
mkdir -p "$BIN_DIR"
ln -s "$PWD/bin/pi-container" "$BIN_DIR/pi-container"
export PATH="$BIN_DIR:$PATH"

mkdir -p ~/projects/demo
cd ~/projects/demo
pi-container
```

普通用户将 PATH 配置保存在 Shell 启动文件中。先选「开发容器管理 → 构建镜像」，再选「启动并托管 Pi」。构建参数逐行填写 `KEY=value`，直接回车表示不添加；不要在 build args 中放密码。

## Gateway 安装与更新

启动托管 Pi 时，入口按 `config/pi-bootstrap.json` 调用原生 `pi install`，安装尚未配置的默认包。Gateway 来源为：

```text
git:github.com/L4nterns/pi-provider-gateway
```

来源不带版本、tag 或提交 SHA，首次安装获取公开默认分支的当前内容，不需要 GitHub token。安装需要访问 GitHub 与 npm；引导器执行的安装失败时明确报错，不写完成标记，网络恢复后可重试。

包和初始化标记保存在持久化的 `data/` 中。成功初始化后不重复安装；用户卸载已记录的来源后，不自动装回。开发 Shell 与接回已有进程都不执行包初始化。

引导器使用 Pi 的原生包路径解析检查已有同名安装，包括本地相对路径、绝对路径、HOME 路径和 file URL。它只读取包元数据，不加载扩展代码、不改写用户包声明、不自动迁移来源。

插件后续更新由原生 Pi 管理。默认 Git 安装可在开发 Shell 中执行：

```bash
pi update git:github.com/L4nterns/pi-provider-gateway
```

更新前协调正在使用该插件的 Pi，再按原生方式重新加载；本项目不在启动时自动升级插件。

进入 Pi 后，使用 `/gateway` 配置网关，使用 `/model` 和 `/thinking` 选择模型与思考档位。输入网关密钥使用遮罩的 `/gateway login`；Pi 1.5.0 的原生 `/login` 输入框会明文回显 secret。

## 菜单与活进程

在具体项目目录运行 `pi-container`：

```text
1) 接回运行中的 Pi       同一进程，继续查看输出和操作
2) 启动并托管 Pi         断开终端后继续运行
3) 结束运行中的 Pi       停止进程，不删除对话历史
4) 开发 Shell
5) 开发容器管理
6) 服务容器管理
0) 退出菜单              运行中的 Pi 继续
```

| 概念 | 含义 |
| --- | --- |
| 运行中的 Pi | 仍存活的进程；没有终端连接时，请求、输出和工具仍可继续执行 |
| 历史对话 | Pi 保存的磁盘数据，不代表进程仍在运行 |
| 终端连接 | 通向进程的一条连接，断开不等于结束 Pi |

- **接回**只连接已有开发容器中的指定进程，不启动容器、不初始化插件、不启动或等待可选服务容器，不重放历史或重发模型请求。容器、进程不存在或状态查询失败时明确报错，不启动替代进程。
- **启动并托管**创建 Pi 进程，不传入历史选择、模型或思考设置。在 Pi 内可以用 `/new`、`/resume` 切换对话；进程标识不是对话文件标识。
- **断开**：`Ctrl+B`，松开，再按 `D`，返回菜单；也可关闭宿主 SSH 终端。仍存活的托管进程继续执行。
- **结束**：在菜单选择进程并确认，会中断请求和工具，不删除历史。
- `0` 返回上级或退出。菜单需要交互终端，不接受管道输入。

### 输出过程中断开与接回

1. 在 Pi 中提交任务。
2. 输出或工具仍在进行时，用 `Ctrl+B d` 断开。
3. 再次进入宿主同一项目目录，运行 `pi-container`。
4. 选择「接回运行中的 Pi」并选中原进程。

多个终端连接同一进程时共享输入和显示，不是隔离观察者，应避免同时输入。tmux 保存终端状态和有限滚屏，不是完整日志或任务检查点，也不能修复上游断流。

Pi 退出、崩溃或容器 / 宿主重启后，原执行状态消失。可启动新 Pi，再用原生 `/resume` 选择历史，但不能复活旧请求和工具。直接在开发 Shell 中运行 `pi` 不经过托管，不承诺断开后继续运行。

停止、删除、重建开发容器会检查终端租约、后台 Pi 和外部 Docker exec；未知状态拒绝维护。最后一个终端离开时，只有没有后台 Pi 和外部连接才自动停止开发容器。

## 终端编码、颜色与主题

托管环境使用 Debian 的 `C.UTF-8`，宿主终端需支持 UTF-8 并提供中文字形。

终端连接显式传递宿主的 `TERM`、`COLORTERM` 和 `COLORFGBG`，避免 Docker 的默认 `TERM=xterm` 让 tmux 把灰阶、256 色和 RGB 压成 8 种基础色。镜像提供 `ncurses-term` 终端描述数据；宿主应如实设置终端类型，非标准类型需要对应的 terminfo。

只有 `COLORTERM=truecolor` 或 `24bit` 明确声明真彩色时，辅助程序才向 tmux 声明 RGB；否则由 TERM / terminfo 决定颜色能力，不一律强制真彩色。

**Pi 主题由原生 `/settings → Theme` 管理。** 默认 `system` 跟随终端调色板；也可自行选择 `dark`、`light` 或主题对。项目不强制深色主题、不重写颜色、不修改用户主题设置。不同终端的 ANSI 调色板及透明背景仍可能带来视觉差异。

接回时 tmux 按当前客户端能力绘制；Pi 自身缓存的主题和能力由原生功能管理。需要改变 Pi 设置时使用 `/settings` / `/reload`；需要重启进程时先保存工作并正常退出，不为调整颜色自动结束任务。

## 容器、权限与数据

远程使用先通过已有 SSH 登录宿主，再在项目目录运行 `pi-container`。宿主操作者必须具有 Docker 权限；Pi 和应用容器不挂 Docker socket，也不开放额外管理端口。

同一安装只使用同一宿主身份。开发进程以非 root 运行；宿主 root 映射到 UID/GID 1000，并通过 ACL 授予工作区访问权。ACL 会持久改变宿主元数据，同机真实 UID 1000 也会得到访问权；这里不是多租户沙箱。详见 [SECURITY.md](SECURITY.md)。

| 位置 | 内容 |
| --- | --- |
| 项目目录 | 挂载为 `/workspace` 的开发文件 |
| `data/` | Pi 配置、凭据、扩展及 `project-history/` 中按项目保存的对话 |
| `.runtime/` | 宿主项目锁和终端连接租约 |
| `.deploy-keys/` | 可选部署管理身份 |
| `services-data/` 或配置的外部目录 | 可选服务持久化数据 |

开发容器身份由安装路径、宿主 UID 和项目路径派生，运行时位于 `/opt/pic`。项目不自动接管其他安装的容器或迁移历史目录。移动安装或切换身份前，应停止相关容器、备份并明确处理数据，避免并行写同一份持久状态。

部署使用独立 Debian 服务容器和标准 SSH/SFTP。服务 SSH 终端不挂载项目或 Pi 数据，也不启动项目开发容器。配置、发布和备份见 [DEPLOYMENT.md](DEPLOYMENT.md)。停止或重建服务会中断应用；删除容器不删除 bind 数据，不保证零停机。

## Pi 版本与镜像维护

Pi 依赖跟随 npm `latest`，安装禁用 lifecycle scripts 和根锁文件生成。容器不在启动时替换 Pi，运行中的进程不热更新。

Docker 构建可能复用依赖缓存。获取新 Pi 时，在「开发容器管理」选择「无缓存构建镜像」，再重建空闲项目容器。实际版本取决于所选 npm registry，兼容性应对实际安装版本运行测试。

## 开发与验证

```bash
npm install --ignore-scripts --package-lock=false
npm run check
# 需要本机 Docker 的真实集成
bash tests/docker-smoke.sh
```

PTY 测试使用 util-linux `script`，转录目标为 `/dev/null`。测试将配置、历史、部署状态和 tmux socket 放在临时目录，不调用付费模型；缺少运行条件时明确报告跳过。

覆盖范围与验证限制见 [VALIDATION.md](VALIDATION.md)。独立 Gateway 的源码和测试见[插件仓库](https://github.com/L4nterns/pi-provider-gateway)。

[MIT License](LICENSE)。
