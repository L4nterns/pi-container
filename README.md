# Pi Coding Agent · Docker

从当前项目目录运行容器化的 [Pi Coding Agent](https://github.com/earendil-works/pi)，内置 [NewAPI provider](https://github.com/L4nterns/pi-provider-newapi) 和可选的静态网站发布技能。

- 每个项目使用独立、可复用的容器，当前目录挂载为 `/workspace`。
- Pi 设置、登录凭据和扩展在同一安装目录下共享，会话按项目分别保存。
- 最后一个会话退出后停止容器，不删除容器内临时安装的工具。
- 不授予容器 Docker 权限，不托管持久运行的动态网站。

## 环境要求

- Linux、Bash 4.1+、GNU coreutils 和 util-linux 的 `flock`。
- 本机 Docker Engine、Docker Compose v2（支持 `config --environment`）。
- 当前用户有 Docker 权限，仓库目录和项目目录可写。

Windows 可通过 WSL 的 Linux 环境使用；不支持原生 PowerShell 启动或远程 Docker daemon。共享此安装目录的项目应属于同一个受信任的用户，不能作为多用户或不可信代码的安全沙箱。

## 安装与使用

```bash
git clone https://github.com/L4nterns/pi-docker.git ~/pi-docker
cd ~/pi-docker
mkdir -p ~/.local/bin
ln -s "$(pwd -P)/bin/pi-docker" ~/.local/bin/pi
```

确保 `~/.local/bin` 已加入 `PATH`。如该位置已有 `pi` 命令，先确认用途，不要直接覆盖。也可以将链接创建到 `/usr/local/bin/pi`（需要管理员权限）。

在要工作的项目目录运行：

```bash
cd ~/projects/my-app
pi
```

首次运行自动构建镜像、创建 `data/` 并安装 provider。后续运行复用该项目容器。禁止从宿主机根目录 `/` 启动；从用户主目录等上层目录启动也会扩大文件访问范围，请使用具体项目目录。

Pi 内配置 NewAPI：

```text
/newapi-provider-add newapi
/login newapi
/model
```

填写网关根地址（如 `https://api.example.com`，不含 `/v1`）和 API Key。协议覆盖等高级选项见 [provider 文档](https://github.com/L4nterns/pi-provider-newapi)；容器内配置位置是 `/home/node/.pi/agent/extension-settings/provider-newapi.json`。

## 命令

| 命令 | 用途 |
| --- | --- |
| `pi` | 在当前项目启动 Pi |
| `pi shell` | 以宿主机 UID/GID 进入 Bash |
| `pi root-shell` | 进入 root Bash，用于安装工具和管理容器内部 |
| `pi stop` | 停止当前项目容器，保留可写层 |
| `pi down` | 删除当前项目容器和网络 |
| `pi down --all`（或 `-a`） | 删除当前用户在此安装目录创建的全部项目容器和网络 |
| `pi ps` | 列出此安装目录创建的项目容器 |
| `pi build [构建参数...]` | 构建镜像，不替换容器 |
| `pi rebuild [构建参数...]` | 无缓存构建镜像 |
| `pi recreate` | 用已构建的镜像重建当前项目容器 |
| `pi --help` | 显示命令用法 |

`pi shell`、`pi root-shell` 接受 Bash 参数，例如 `pi shell -c 'node --version'`。包装器不直接透传 Pi 参数；需要时可在 `pi shell` 中运行 `pi --help`、`pi --continue` 等原生命令。

通过包装器打开的同项目会话可并发使用。启动、退出和维护操作由宿主机文件锁协调；有活动会话时 `stop`、`recreate`、`down` 会拒绝操作。原始 `docker exec` 不参与会话锁，不应与这些维护命令混用。终端异常断开后可用 `pi ps` 核对并用 `pi stop` 停止闲置容器。

容器不会共享临时安装的软件。需要所有项目都有的工具应加入 Dockerfile，执行 `pi build`，再在相应项目目录执行 `pi recreate`。**重建或删除容器会丢失未挂载的可写层**，但不删除项目文件、`data/` 或发布目录。

## 数据与权限

| 宿主机路径 | 容器路径 / 用途 |
| --- | --- |
| 启动时的当前目录 | `/workspace`，读写 |
| 仓库 `data/` | `/home/node/.pi/agent`，共享设置、凭据和扩展 |
| 仓库 `data/project-sessions/<UID>-<项目哈希>/` | 当前项目的 Pi 会话 |
| 仓库 `.runtime/` | 宿主机侧会话锁，不挂载进容器 |
| 可选发布目录 | `/vibe-projects`，读写 |

项目和安装目录使用规范化绝对路径识别；移动目录会改变项目标识。Pi 和普通 Shell 使用宿主机 UID/GID 及附加组；`root-shell` 使用 `/root` 作为 HOME。容器常驻进程保留 root 以支持权限初始化和安装工具，但普通 Pi 会话会降权。不要使用 `sudo pi` 作为日常工作方式。

同一安装目录的所有项目可以读取共享登录凭据并修改共享扩展；启用发布后也能写入整个发布目录。这是**受信任的个人开发环境**，不是站点级或项目级权限隔离。需要不同信任边界时使用不同安装目录、发布目录和凭据。详见 [SECURITY.md](SECURITY.md)。

## 静态网站发布

默认不启用发布技能。需要先配置一个独立的静态 Web 服务器，本工具不会安装 Nginx、配置 DNS 或自动取得 TLS 证书。

在工具仓库内复制配置并填写两项：

```bash
cp .env.example .env  # 已有 .env 时直接编辑，不要覆盖
```

```dotenv
VIBE_PROJECTS_HOST_DIR=/srv/vibe-projects
VIBE_PUBLIC_URL=https://example.com
```

发布目录必须已存在、对当前用户可写，与项目目录及 Pi 配置数据分离。外部 Web 服务器应将其作为静态站点根目录；关闭目录列表，禁止访问 `.publish-internal` 等隐藏路径，不要将此目录配置为 PHP 等服务端脚本执行目录。

配置后在要发布的项目目录执行 `pi recreate`。启用的项目可使用 `/skill:vibe-projects`，也可在容器内显式调用：

```bash
node /opt/pi-docker/skills/vibe-projects/scripts/publish.mjs demo /workspace/已核实的构建目录
```

产物发布到 `/vibe-projects/demo/`，网址为 `VIBE_PUBLIC_URL/demo/`。域名和服务器持续可用时，Pi 容器退出不会影响已发布文件。

发布前必须完成构建和人工审查，只选择静态产物，不发布源码仓库、依赖、环境文件、凭据或源码映射。脚本拒绝常见危险文件、符号链接和高置信度凭据特征；疑似凭据字段和错误资源前缀会产生提醒，扫描不能替代安全审查。

资源需适用于 `/demo/` 子路径。无 SPA 回退配置时使用哈希路由。脚本先复制并检查私有暂存区，再替换站点；两次目录重命名间可能有短暂空窗，不保留历史版本。异常中断后先检查输出和暂存锁，不要在仍有发布进程时删除锁。复制成功不等于公网验证成功，应检查项目 URL 和关键资源，而不是域名根路径。

## 构建与检查

同一安装目录的项目共用该安装独立的本地镜像标签，不同安装目录的构建不会互相覆盖。Node 基础镜像锁定摘要，Pi 的 npm 依赖由 `package-lock.json` 固定，provider 锁定 Git 提交；系统软件包仍从 Debian 安全维护源安装。默认使用官方软件源，npm 网络受限时可指定：

```bash
pi build --build-arg NPM_REGISTRY=https://registry.npmmirror.com
```

本地检查需要 Node.js 24、Bash、`flock`，建议安装 ShellCheck：

```bash
bash scripts/check.sh
bash tests/docker-smoke.sh  # 另需本机 Docker，构建临时测试镜像
```

CI 执行脚本检查、隔离回归测试、Compose 配置解析和容器冒烟测试。测试使用临时目录，不发布真实站点。

## 清理

在项目目录执行 `pi down`；清理当前用户在本安装目录创建的所有项目，先用 `pi ps` 确认，再执行 `pi down --all`。这些操作均保留宿主机项目文件、`data/` 和静态发布文件。

卸载时退出会话、清理容器，再核对并删除安装时创建的 `pi` 软链接。仓库 `data/` 含凭据和会话记录，只在确认不再需要后删除；发布目录由用户单独管理。`.env`、`data/`、`.runtime/` 已从 Git 和 Docker 构建上下文排除。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。第三方依赖遵循各自的许可证。
