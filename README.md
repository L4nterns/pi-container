# Pi in Container · `pic`

在容器中运行原生 [Pi Coding Agent](https://github.com/earendil-works/pi)，托管仍在输出或执行工具的 Pi 进程，断开终端后再接回同一个进程，并管理开发容器与独立服务容器。宿主无需安装 Node.js 或 Pi。

项目仓库：[L4nterns/pic](https://github.com/L4nterns/pic)。网关插件独立维护于公开仓库 [L4nterns/pi-provider-gateway](https://github.com/L4nterns/pi-provider-gateway)，不随 pic 提交或打包源码。

**宿主入口只记 `pic`，通过菜单管理运行环境和活进程。** 它不是 `pi` 的缩写或参数转发器，不重新包装 Pi 的对话命令，也不提供旧命令兼容入口。本版仅保留终端功能，没有浏览器控制台、管理 HTTP API 或后台管理网站。

| 负责方 | 职责 |
|---|---|
| 原生 `pi` | 对话、`/new`、`/resume`、`/compact`、模型、思考档位、provider 与插件 |
| `pic` | 容器生命周期、启动并托管进程、断开后保持运行、重新接回原进程、明确结束进程 |

截至本轮核对，原生 Pi 的 `pi --resume` / `--continue` 恢复的是磁盘历史，**不是接回一个仍在输出的 TUI 进程**；RPC 也不是附着到既有交互终端的命令。pic 通过容器内 tmux 补上这层进程与终端生命周期管理，不修改 Pi 原生命令。账号、路由、额度仍由上游管理。

## 安装

需要 Linux、Bash 4.1+、GNU coreutils、`flock`，及有权限使用的本机 Docker Engine / Compose v2。部署功能另需 OpenSSH 客户端。不支持远程 Docker、原生 Windows，WSL 请使用 Linux 环境。

**入口名称冲突：** groff 也提供 `pic`。与 groff 共存时，先不要创建下面的全局 `pic` 链接；可以用本仓库 `bin/pic` 的绝对路径启动菜单。不要覆盖 `/usr/bin/pic` 或靠 PATH 优先级抢占系统命令。公开入口的新名称待确认，仓库名与数据路径不因此自动迁移。

以下只用于**全新安装**；已有配置、凭据和业务数据不要覆盖。本仓库提供源码，尚未发布预构建镜像。

```bash
tar --same-permissions -xzf pic-source.tar.gz
cd pic
printf 'DEPLOY_DATA_DIR=\n' > .env

if [ "$(id -u)" = 0 ]; then BIN_DIR=/usr/local/bin; else BIN_DIR="$HOME/.local/bin"; fi
mkdir -p "$BIN_DIR"
ln -s "$PWD/bin/pic" "$BIN_DIR/pic"
export PATH="$BIN_DIR:$PATH"

mkdir -p ~/projects/demo
cd ~/projects/demo
pic
```

普通用户将 PATH 配置保存在 Shell 启动文件中。首次打开菜单，先选「开发容器管理 → 构建镜像」，再选「启动并托管 Pi」。构建可逐行填写 `KEY=value` build args，直接回车表示不添加。不要在 build args 中放密码。

## Gateway 在线安装

首次初始化开发环境时，通用引导器按 `config/pi-bootstrap.json` 调用原生 `pi install`，从公开的 [pi-provider-gateway](https://github.com/L4nterns/pi-provider-gateway) 仓库下载插件；**不需要 GitHub token**，pic 仓库、源码包和镜像均不捆绑插件实现。安装源不带版本、tag 或提交 SHA，首次安装解析仓库默认分支的当前内容。

首次安装需要能访问 GitHub 与 npm；下载失败会明确报错，且不写完成标记，修复网络后可重试。安装存于持久化的 `data/`，成功后引导器不重复安装；同一 source 被用户卸载后也不会每次启动自动装回。

**不固定版本不等于每次启动自动升级。** pic 不增加插件更新策略、进程租约或额外启动器；插件后续更新由 Pi 原生包管理负责，例如在开发 Shell 中运行 `pi update git:github.com/L4nterns/pi-provider-gateway`。更新前自行协调正在使用该插件的 Pi，再按原生方式重新加载。

已有同名本地包不会被自动替换或再加载一份，不做安装来源迁移。需要改用 Git 安装时，先备份并用 Pi 原生包管理检查旧声明，再自行切换；不要覆盖配置、密钥、模型例外或历史。

进入 Pi 后，使用 `/gateway` 配置 URL / Key，使用 `/model` 和 `/thinking` 选择模型与思考档位。网关扩展独立于 pic，配置和凭据保存在 `data/`。本轮实测的原生 `/login` 会明文回显 secret，网关密钥应走遮罩的 `/gateway login`。

## Pi 版本与更新

**pic 不固定 Pi 版本。** 依赖跟随 npm 的 `latest` 发布标签；Docker 和开发测试均使用 `npm install --ignore-scripts --package-lock=false`，不交付根锁文件，项目 `.npmrc` 也关闭锁文件生成。Gateway 安装源同样不固定版本，但不因此改变首次安装与原生更新的职责分工。

Docker 可能复用已有的依赖安装层，不代表每次普通构建都会重新下载。需要获取新 Pi 时，在「开发容器管理」选择「无缓存构建镜像」，再对空闲项目选择「重建当前项目容器」。安装从所选 npm registry 解析 `latest`，不是固定到某个版本号。

已运行的 Pi 不热更新；容器启动时也不自动联网替换 Pi、改写凭据或降级。新版本的兼容性由测试和实际使用确认，不能把本轮验收视作对所有未来版本的保证。

## 菜单：只管理运行环境和活进程

在具体项目目录运行 `pic`：

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
|---|---|
| 运行中的 Pi | 容器内仍然活着的进程；没有终端连接时，请求、输出和工具仍可继续执行 |
| 历史对话 | Pi 保存的磁盘数据，由 Pi 管理；不代表进程还在运行 |
| 终端连接 | 宿主终端通向进程的一条连接；断开连接不等于结束 Pi |

- **接回**只列活进程，显示「后台运行 · 没有终端连接」或连接数。仍在输出时也能接回；不重启 Pi、不读取历史来重放任务、不重新发起模型请求。选错、进程已退出或查询失败时明确报错，不自动启动替代进程。
- **启动并托管**创建一个容器内 Pi 进程，用原生 TUI 操作它；不传入 `--resume`、`--continue` 或模型设置，不替用户选择历史。一个托管进程中可以使用 Pi 的 `/new` 或 `/resume` 切换对话，进程标识与对话文件不是一回事。
- **断开**：`Ctrl+B`，松开，再按 `D`，回到菜单；Pi 中正在进行的请求与工具不因终端断开而被主动中断。关闭宿主终端也保留托管进程。
- **结束**：在菜单选进程并确认；会中断正在进行的请求和工具，不删除历史。
- 选择 `0` 返回上级或退出。pic 不自动决定接回或另起进程，需要交互终端，不接受管道或 Pi 参数直通。

### 正在输出时，断开再接回

1. 在菜单选「启动并托管 Pi」，进入 Pi 后正常提交任务。
2. 输出或工具仍在进行时，用 `Ctrl+B d` 断开，或关闭宿主 SSH 终端。
3. 再次登录宿主，进入同一项目，运行 `pic`，选「接回运行中的 Pi」。
4. 选中原进程，继续查看其当前输出和操作。原进程若仍存活，不应改用 `/resume` 或启动另一个 Pi 来替代接回。

多个终端可连接同一进程并共享输入与显示，不是隔离观察者，请避免同时输入。tmux 保存终端状态和有限滚屏，不是无限日志或任务检查点，也不能修复模型服务本身的断流。

Pi 自己退出、容器 / 宿主重启或进程崩溃后，原执行状态已经消失。此时可启动并托管一个 Pi，再在 **Pi 内用 `/resume`** 选择已保存的历史；这不能复活之前正在执行的请求或工具。直接在开发 Shell 中执行 `pi` 仍是原生命令，但不经过 pic 托管，不承诺断开后继续运行。

停止、删除、重建开发容器会检查终端租约、后台 Pi 和外部 Docker exec；未知状态拒绝维护。最后一个终端离开，不会误停仍有后台 Pi 的容器。

## 终端字符编码

容器内托管 Pi 使用 Debian 自带的 `C.UTF-8` locale，tmux 与其启动的 Pi / 工具必须继承 UTF-8；不能为了固定英文错误消息而将整个进程树设为 ASCII 的 `LC_ALL=C`。宿主终端仍需支持 UTF-8 并有中文字形，容器不安装字体来替代宿主终端渲染。

已有 tmux server / Pi 可能保留启动时的旧环境；源码或镜像更新不热修改正在运行的进程。保存工作并正常退出旧 Pi 后，在修复后的镜像中启动新的托管 Pi，再检查中文输出与输入；仅接回旧进程不一定改变其环境。不需要修改历史、provider 或模型配置来修复编码。

## 远程终端与权限

远程使用时，先通过自己的 SSH 登录宿主，在项目目录运行 `pic`；不额外开放管理网站、管理端口或 Docker API。Docker 操作由宿主当前用户执行，仍要求该用户已有相应权限；取消网页不等于取消宿主 Docker 权限。Pi 与应用容器不挂载 Docker socket，详见 [SECURITY.md](SECURITY.md)。

## 服务与持久数据

开发 Shell 中执行项目命令、脚本、测试；服务容器菜单中的 SSH 终端用于容器内 sudo、发布、SFTP、路由和应用运行时管理。SSH 终端不挂载项目或 Pi 数据、不启动项目开发容器。部署按 [DEPLOYMENT.md](DEPLOYMENT.md) 配置 `DEPLOY_DATA_DIR`。

| 位置 | 内容 |
|---|---|
| 项目目录 | 挂载为 `/workspace` 的开发文件 |
| `data/` | Pi 配置、凭据、扩展，以及 `project-history/` 下按项目保存的对话 |
| `.runtime/` | 宿主项目锁、终端连接租约 |
| `.deploy-keys/`、`services-data/` | 可选部署身份和应用业务数据 |

删除容器不删除 bind 数据；服务停止和重建会中断应用，不保证零停机。同一安装只使用同一宿主身份。宿主 root 的开发进程映射到 UID 1000，工作区 ACL 修改会保留；同机 UID 1000 也会得到访问权，不是多租户沙箱。

## 无旧版兼容层

本版只有 `pic` 菜单，不保留旧命令别名、旧多词入口、旧环境变量、旧镜像路径或迁移标记识别。开发容器使用 `pic-*` 身份，运行时路径 `/opt/pic`；不自动接管旧版容器，也不迁移旧历史目录。

这不意味着删除旧数据：源码改动没有清空原配置、凭据、模型例外、历史或业务目录。已有安装应先备份并自行停止旧容器，明确处理已有身份与数据，再安装本版；不要新旧版本同时写同一份持久数据，也不要覆盖现有 `.env`。本次交付和源码推送不表示已更新不可见的宿主安装或发布镜像。

## 开发与验证

```bash
npm install --ignore-scripts --package-lock=false
npm run check
# 真正 Docker / SSH / tmux 集成，需要本机 Docker
bash tests/docker-smoke.sh
```

测试中的 PTY 由 util-linux 的 `script` 提供，不记录转录文件，也不需要额外 npm 依赖。真实 tmux 测试需要 `tmux`；缺少条件时明确跳过。验证范围见 [VALIDATION.md](VALIDATION.md)。独立 Gateway 的源码、测试与安装说明见[插件仓库](https://github.com/L4nterns/pi-provider-gateway)，不保存在 pic 中。

[MIT License](LICENSE)。
