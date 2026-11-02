# Pi Coding Agent · Docker

使用 Docker Compose 运行 [Pi Coding Agent](https://github.com/earendil-works/pi)，自动安装 [pi-provider-newapi](https://github.com/L4nterns/pi-provider-newapi)，通过 NewAPI 发现和选择模型，无须手动维护模型列表。

`pi` 命令从**当前目录**启动容器中的 Pi：每个宿主机项目使用独立、可复用的容器；Pi 配置、凭据和插件共享保存在宿主机。集成了 Bash 提示符美化、大小写不敏感补全和可选的静态网站发布技能。

## 环境要求

- Linux（支持 Bash、`readlink`、`realpath`、`sha256sum`、`id` 等常见命令）
- Docker Engine / Docker Desktop、Docker Compose v2
- 当前账号有运行 Docker 的权限

容器基础镜像为 `node:24-trixie-slim`，不依赖 WSL 或特定 Linux 发行版。Windows 上可以在 WSL 的 Linux 环境中运行，但当前启动脚本不是 Windows 原生 PowerShell 程序。

## 安装

克隆仓库并创建全局命令（以下示例使用 `~/pi-docker`）：

```bash
cd ~/pi-docker
sudo ln -s "$(pwd -P)/bin/pi-docker" /usr/local/bin/pi
```

不想使用管理员权限，可以安装到自己的 `~/.local/bin`，并确保它已加入 `PATH`：

```bash
mkdir -p ~/.local/bin
ln -s "$(pwd -P)/bin/pi-docker" ~/.local/bin/pi
```

工具会从软链接找到仓库根目录，仓库移动后需要重新创建链接。首次运行时自动构建镜像，并在宿主机仓库下创建 `data/` 目录。无需安装 GNU Make。

## 快速开始

在**想让 Pi 工作的目录**直接执行：

```bash
cd ~/projects/my-app
pi
```

或者：

```bash
cd /srv/another-project
pi
```

当前宿主机目录会被挂载为容器的 `/workspace`。不同目录使用不同容器和独立的项目会话目录；相同目录再次运行会复用容器。为避免误暴露整台宿主机，不允许直接从根目录 `/` 启动。

Pi 正常退出（包括 `/quit`）后，如果当前项目没有其他活动的容器交互会话，`pi` 会自动**停止但不删除**该容器；下次运行时重新启动并复用已有容器，APT 安装的工具仍保留。若同一项目还有其他活动的 `docker exec` 会话，则不会自动停止，以免打断其他终端。**不同项目容器并不共享这些临时安装的软件**；需要所有项目都有的工具请加入 Dockerfile 再重新构建镜像。

## 配置 NewAPI

在 Pi 内执行：

```text
/newapi-provider-add newapi
/login newapi
/model
```

填写 NewAPI 网关地址（例如 `https://api.example.com`，不含 `/v1`）和 API Key，再选择模型。模型由插件发现；少数未知模型可能需要补充元数据。

如果模型错误使用 `/v1/responses` 返回 404，而网关仅支持 `/v1/chat/completions`，在仓库的 `data/extension-settings/provider-newapi.json` 中对应 Provider 的配置对象内增加：

```json
"modelApiOverrides": {
  "^your-model-id$": "openai-completions"
}
```

替换为实际模型 ID（正则特殊字符需要转义），保存后重启 Pi 并使用 `/model` 刷新模型目录。

## 常用命令

以下命令均在**当前宿主机目录对应的项目容器**中操作：

| 命令 | 用途 |
| --- | --- |
| `pi` | 启动或进入当前项目的 Pi |
| `pi shell` | 以宿主机 UID/GID 进入普通 Bash |
| `pi root-shell` | 进入 root Bash，仅用于容器管理和安装工具 |
| `pi stop` | 手动停止当前项目容器，保留容器可写层（通常无需执行） |
| `pi down` | 删除当前项目容器和 Compose 网络 |
| `pi down -a`（等价于 `pi down --all`） | 删除本仓库创建的全部项目容器及对应网络 |
| `pi ps` | 查看本仓库的项目容器（包括已停止的） |
| `pi build` | 构建共享镜像，不替换已创建的容器 |
| `pi rebuild` | 无缓存重新构建共享镜像 |
| `pi recreate` | 用现有镜像重建当前项目容器 |

`pi down` 应在要清理的项目目录运行；`pi ps` 和 `pi down -a`（或 `--all`）可在任意目录运行。`down -a` 和 `down --all` 仅匹配此仓库路径下、名称符合本项目规则的 Compose 容器。直接在仓库里运行 `docker compose down` 既缺少动态变量，也不会使用各项目的 Compose 项目名，因此不应使用。

镜像更新后，需要对要更新的项目分别执行 `pi recreate`。重新创建或删除容器会丢失其**未挂载的可写层**，包括通过 APT 临时安装的软件，但不会删除宿主机项目文件和仓库中的 `data/`。

Pi 的默认设置、登录凭据及扩展位于仓库 `data/`。项目会话通过宿主机目录的哈希分别保存在 `data/project-sessions/` 下，避免不同项目都使用容器路径 `/workspace` 时混合会话。

## 卸载与清理

清理当前项目：在该项目目录执行 `pi down`。清理此仓库管理的全部项目容器：在任意目录执行 `pi down -a`；先用 `pi ps` 核对清理范围。两者都不会删除仓库的 `data/`、宿主机工作目录或静态网站发布目录。

彻底卸载时，先执行 `pi down --all`，再删除指向本仓库的全局命令软链接：

```bash
# 使用哪一种安装位置，就执行相应命令；删除前确认确实是本仓库的链接
readlink -f /usr/local/bin/pi
sudo rm /usr/local/bin/pi
# 或：rm ~/.local/bin/pi
```

可按需删除共享镜像：

```bash
docker image rm pi-docker:local
```

最后仅在确认不再需要登录配置、会话和项目记录时删除仓库目录，其中 `data/` 保存这些持久化内容。用户自己的项目目录以及 `VIBE_PROJECTS_HOST_DIR` 所指向的静态网站目录均应单独管理，卸载不会自动清理。

## Bash 体验

容器内的交互式 Bash 配置了两行彩色提示符，同时启用 Readline 的 `set completion-ignore-case on`，文件名补全不区分大小写。通过 `pi shell` 使用；它不改变 Pi 自身的界面和宿主机的 Bash 设置。

## 静态网站发布

项目内置可选的 `vibe-projects` 技能，用于将当前项目的静态构建产物发布到网站目录。技能文件位于 `skills/vibe-projects/`。

默认不加载此技能，也不挂载发布目录。在仓库的 `.env` 中配置以下两项即可启用：

```dotenv
VIBE_PROJECTS_HOST_DIR=/srv/vibe-projects
VIBE_PUBLIC_URL=https://example.com
```

启用后，Pi 会自动加载 `vibe-projects` 技能，可通过 `/skill:vibe-projects` 使用。未启用时，该内置技能不会出现在 Pi 的技能列表中，不影响其他普通 Skills 的自动发现。

`VIBE_PROJECTS_HOST_DIR` 必须是宿主机上**已存在、可写**的**绝对路径**；静态 Web 服务器应将对应目录用作站点根目录。

更改配置后，进入需要发布的网站项目目录，执行 `pi recreate` 更新该项目容器的挂载及环境变量。如果修改了 Dockerfile 或入口脚本，需要先执行 `pi build`，再执行 `pi recreate`。

技能依据项目实际构建流程确认要发布的静态目录，发布脚本必须显式传入该目录。可在容器中手动调用，例如：

```bash
node /opt/pi-docker/skills/vibe-projects/scripts/publish.mjs demo /workspace/构建产物目录
```

脚本会检查静态目录和独立发布挂载，然后把文件复制到 `/vibe-projects/demo/`，输出网址。只发布静态网站，不要公开服务端程序、密钥、环境文件或整个源码仓库。公网可能有 Cloudflare 质询，因此本地复制成功不等于公网 HTTP 检查一定成功。

## 路径与权限

每个容器只挂载当前项目目录为 `/workspace`，并共享仓库中的 `data/`；若启用发布功能，还会挂载公共发布目录。**工作目录分开不等于完整的安全沙箱**：Pi 仍有项目目录的读写权限和共享的 API 凭据；`root-shell` 仍可获取容器内 root 权限。

Pi 进程和普通 `pi shell` 使用执行 `pi` 的宿主机 UID/GID，避免项目文件被意外创建为 root 所有。`pi root-shell` 专供管理用途，并使用 `/root` 作为 HOME，避免 root 的 npm 操作污染普通用户缓存。建议使用普通宿主机账号，并只在具体项目目录执行；如果从用户主目录等上层目录启动，该目录下的凭据和其他文件也可能被 Pi 访问。

本仓库的 `.env`、`data/` 均应保留在宿主机，不要提交到 Git。Dockerfile 使用清华 TUNA Debian 镜像和 [npmmirror](https://npmmirror.com/) 加速安装；基础镜像拉取失败时请检查 Docker 代理配置。

## 相关项目

- [Pi Coding Agent](https://github.com/earendil-works/pi)
- [pi-provider-newapi](https://github.com/L4nterns/pi-provider-newapi)
