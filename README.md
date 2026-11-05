# Pi in Docker

在 Docker 中运行 [Pi Coding Agent](https://github.com/earendil-works/pi)，无需在宿主安装 Node.js 或 Pi。`devctl` 是宿主命令：进入项目目录，执行即可开始开发。

- 当前项目挂载到容器 `/workspace`，Pi 和开发 Shell 均以非 root 身份运行。
- 每个项目使用独立开发容器，同一项目可打开多个会话。
- 各项目共享 Pi 配置、凭据和扩展，会话按项目保存，容器删除后仍可使用。
- 内置 [NewAPI provider](https://github.com/L4nterns/pi-provider-newapi)；可选独立应用服务容器。

## 安装与首次运行

需要 Linux、Bash 4.1+、Git、GNU coreutils、`flock`，以及有权限使用的本机 Docker Engine / Compose v2（支持 `config --environment`、`up --wait`）。WSL 使用 Linux 环境；不支持原生 PowerShell，未验证 Podman 或远程 Docker。

以下用于全新安装，先只运行 Pi。已有安装不要覆盖 `.env` 或同名命令。

```bash
git clone https://github.com/L4nterns/pi-docker.git ~/devctl
cd ~/devctl
printf 'DEPLOY_DATA_DIR=\n' > .env

if [ "$(id -u)" = 0 ]; then
    BIN_DIR=/usr/local/bin
else
    BIN_DIR="$HOME/.local/bin"
fi
mkdir -p "$BIN_DIR"
ln -s "$PWD/bin/devctl" "$BIN_DIR/devctl"
export PATH="$BIN_DIR:$PATH"
command -v devctl

mkdir -p ~/projects/my-app
cd ~/projects/my-app
devctl
```

首次运行需要联网构建镜像、安装 provider。使用 NewAPI 时，在 Pi 中依次配置：

```text
/newapi-provider-add newapi
/login newapi
/model
```

普通用户需将 `export PATH="$HOME/.local/bin:$PATH"` 加入 Shell 启动文件；Bash 通常使用 `~/.bashrc`，登录配置应加载它。宿主原有的 `pi` 不受影响。

## 日常使用

在需要开发的项目目录运行：

```bash
devctl                         # 运行 Pi
devctl shell                   # 进入开发 Bash，不安装 provider
devctl shell -c 'npm test'      # 执行命令
devctl shell -s < script.sh     # 从标准输入执行脚本
```

`shell` 接受 Bash 参数，保留输入、输出和退出码；`-lc '命令'` 使用登录 Shell。多个终端可进入同一项目，最后一个会话正常退出后停止开发容器，不删除文件或会话。

| 命令 | 用途 |
| --- | --- |
| `devctl ps` | 查看本安装、当前宿主用户的开发容器 |
| `devctl stop` | 停止当前项目的空闲容器 |
| `devctl down [--all]` | 删除当前项目的空闲开发容器；`--all` 覆盖本安装当前用户的全部项目，均保留数据 |
| `devctl build / rebuild [构建参数...]` | 构建 / 无缓存构建开发镜像 |
| `devctl recreate` | 用现有镜像重建当前项目的空闲容器 |

有活动会话时拒绝 `stop`、`down` 和 `recreate`。构建镜像不会替换已有容器，需退出会话后执行 `recreate`；长期开发工具应写入 `Dockerfile`，不依赖容器可写层。不要混用原始 `docker exec` 与维护命令。

## 文件与权限

| 位置 | 内容 |
| --- | --- |
| 当前项目目录 | 源码与开发输出，直接读写宿主文件 |
| 安装目录 `data/` | Pi 配置、凭据、扩展与项目会话 |
| 安装目录 `.runtime/` | 宿主会话协调状态，不挂入容器 |

同一安装固定使用一个宿主身份，项目之间不隔离 Pi 凭据。不要从 `/`、安装目录或包含共享凭据与服务数据的目录启动开发会话。

普通用户使用宿主 UID/GID；宿主 root 映射到容器 UID/GID 1000，并为工作区添加**会保留在宿主上的 ACL**，同机 UID 1000 也因此获得访问权。无需在宿主安装 ACL 工具，但文件系统必须支持 POSIX ACL。完整边界见 [SECURITY.md](SECURITY.md)。

## 可选：应用部署

需要让应用独立于 Pi 会话运行时，在安装目录 `.env` 中设置 `DEPLOY_DATA_DIR`。`app-deployment` skill 通过 SSH/SFTP 管理一个共享的 Debian 服务容器；退出或删除开发容器不影响应用。

宿主使用 `devctl server [Bash 参数...]` 进入服务端，接受与 `shell` 相同的 Bash 参数。配置、持久化、备份及公网入口见 [DEPLOYMENT.md](DEPLOYMENT.md)，配置项见 [.env.example](.env.example)。部署不是使用 Pi 的前提。

## 开发与检查

修改本仓库需 Node.js 24；完整源码检查另需 Python 3、ShellCheck 和 OpenSSH。

```bash
npm ci --ignore-scripts
npm run check
bash tests/docker-smoke.sh
```

Docker smoke 使用隔离临时状态，不读取真实 `.env` 或业务数据，也不验证公网；需要本机 Docker，无需宿主 Node.js。部分真实工具测试需 root 或指定 `TEST_SERVICE_ROOTFS`，条件不足时会跳过。

[MIT License](LICENSE)。
