# devctl · 容器化开发与应用管理

使用 `devctl` 在当前项目中运行容器化的 [Pi Coding Agent](https://github.com/earendil-works/pi)，内置 [NewAPI provider](https://github.com/L4nterns/pi-provider-newapi)。使用 `appctl` 将应用发布到独立服务容器，应用不依赖终端、Pi 会话或开发容器存活。

```text
项目开发容器 ──appctl / 受限 SSH──→ 独立服务容器（安装级管理、每应用用户、进程监督、内部 Nginx）
                                               ↑
公网 HTTPS :443 ──宿主机 Nginx──→ 127.0.0.1:18080
```

`devctl` 是宿主机开发环境工具，`appctl` 是应用管理工具；二者均为本项目提供，不是 Pi 上游命令。命令及配置按职责命名，不绑定容器引擎。当前实现和集成测试使用 Docker Engine / Compose v2，**尚未验证 Podman 支持**；中性命名不代表可直接替换引擎。

不挂载容器引擎 socket，不向 Pi 开放 root Shell；新增应用无需修改宿主端口或逐项编辑宿主机 Nginx。所有应用使用同一发布契约，不区分静态和动态部署。

## 环境要求

- Linux、Bash 4.1+、GNU coreutils、`flock` 和 OpenSSH 客户端。
- 本机 Docker Engine、Docker Compose v2，支持 `config --environment` 和 `up --wait`。
- 单一、非 root 的受信任宿主机用户，具有 Docker 权限；仓库和项目目录可写。
- 公网访问需已有宿主机 Nginx、DNS 与 HTTPS 证书。

WSL 可使用 Linux 环境；不支持原生 PowerShell 或远程容器引擎。开发项目仍共享 Pi 配置和登录凭据，本工具不是多租户或恶意代码安全沙箱。

## 安装与使用

```bash
git clone https://github.com/L4nterns/pi-docker.git ~/devctl
cd ~/devctl
mkdir -p ~/.local/bin
ln -s "$(pwd -P)/bin/devctl" ~/.local/bin/devctl

cd ~/projects/my-app
devctl
```

确保 `~/.local/bin` 在 `PATH`；不要覆盖用途不明的同名命令。`devctl` 不占用宿主机的 `pi` 命令，容器中的 `pi` 仍是上游 CLI。首次启动构建开发镜像并安装 provider；随后复用项目容器。

项目目录挂载为 `/workspace`。禁止从 `/`、工具仓库或包含它的上层目录启动开发会话；也不能将共享配置、部署密钥或服务数据作为工作区挂载。请进入独立的具体项目，不要挂载包含无关敏感文件的目录。

Pi 中使用 `/newapi-provider-add newapi`、`/login newapi`、`/model` 配置模型。网关根地址不含 `/v1`；更多选项见 [provider 文档](https://github.com/L4nterns/pi-provider-newapi)。

## 部署配置与数据目录

在工具仓库复制 `.env.example` 为 `.env`（已有文件则编辑）。默认示例将服务数据保存在工具仓库内的独立目录，不需要创建宿主机 `/srv` 目录：

```dotenv
DEPLOY_DATA_DIR=./services-data
DEPLOY_PORT=18080
DEPLOY_PUBLIC_URL=https://app-{app}.example.com
```

| 配置 | 含义 |
| --- | --- |
| `DEPLOY_DATA_DIR` | 部署持久目录，保存安装控制身份、应用 UID 映射、产物、运行定义、业务数据、日志和 SSH 主机密钥；留空禁用部署 |
| `DEPLOY_PORT` | 只绑定宿主机 `127.0.0.1` 的固定 HTTP 入口，默认 `18080` |
| `DEPLOY_PUBLIC_URL` | 可选公网模板，形如 `http(s)://app-{app}.example.com`，只出现一次 `{app}`；为空也可部署，但不能做公网检查 |

相对目录**始终以工具仓库根目录为基准**，不受调用 `devctl` 时的项目目录影响。`devctl` 自动创建缺失目录，初始权限为 `0700`，Compose 不隐式创建 bind 源目录。仓库内只允许专用 `./services-data`；也可指定仓库外独立的绝对或相对目录。默认目录已被 Git 和镜像构建忽略，不能将部署数据放入 `data/` 或源码目录。

`DEV_*` 用于开发容器身份、工作区和镜像，`DEPLOY_*` 用于部署控制，`APP_DATA_DIR` 用于应用持久数据；这些均由本项目定义。`PI_CODING_AGENT_SESSION_DIR` 是传给 Pi 的上游变量。身份、镜像和网络等内部值由 `devctl` 生成，不需要在 `.env` 手工配置。

```bash
# 从独立项目目录操作；服务管理也可在工具仓库运行
devctl services up
devctl
```

首次启用登记安装级 `deploy` 控制账号和共享公钥；每个应用单独分配非 root 运行 UID。所有项目共享应用管理权限，不按源码目录归属授权。每个安装目录只有一个服务容器。开发容器只读挂载安装部署密钥，不挂载服务数据。更改配置后使用 `devctl services recreate` 和 `devctl recreate` 更新已有容器；前者会中断并恢复所有已启用应用，后者要求先退出当前项目会话。

### 宿主机 Nginx

参考 [config/nginx-apps.conf](config/nginx-apps.conf)，替换示例域名 `example.com`，增加一个 `app-*` 子域名代理块。复用既有 TLS 证书、Cloudflare real-IP 设置和 `$connection_upgrade` 映射。由管理员检查并重载 Nginx，本工具不修改现有站点。

DNS 可使用代理的 `*.example.com` 记录，证书需要覆盖对应子域名。`app-demo.example.com` 只有一层子域名，适用于该域作为 Cloudflare 完整托管区域时的免费 Universal SSL；不使用 `demo.apps.example.com`。已有精确 DNS 记录优先于泛域名记录。

宿主机 Nginx 统一处理 HTTPS，服务容器自动登记应用路由，支持 WebSocket、SSE；未知应用返回 404。公网入口只需配置一次，后续发布不改宿主机 Nginx，也不新增宿主端口。

## 应用管理

Pi 会获得应用管理说明，不依赖 skill。在开发容器中运行 `appctl`；也可从宿主机调用，例如 `devctl apps list`。

| 命令 | 行为 |
| --- | --- |
| `appctl deploy <app> <目录>` | 上传审查过的产物；候选内部 HTTP 和网关就绪后启用或替换应用 |
| `appctl list` | 列出本安装的所有应用、启用状态和进程状态 |
| `appctl status <app>` | 查看当前状态并探测内部 HTTP 健康；不验证公网 |
| `appctl logs <app>` | 返回日志末尾最多 64 KiB；不提供持续跟随 |
| `appctl start <app>` | 用持久运行定义启用已停止应用，不重新上传；已启用时只查询状态 |
| `appctl restart <app>` | 用现有产物启动新候选，通过就绪检查后替换原进程 |
| `appctl stop <app>` | 停止进程、撤路由、禁用自动恢复，保留全部文件与应用名 |
| `appctl delete <app> --yes` | **永久删除应用产物、数据、日志及登记，释放应用名** |
| `appctl verify <app>` | 从当前客户端检查配置的公网 URL；不代表内容正确 |

没有应用的命令不接受应用参数。同一安装的所有项目可以共同管理任意应用；运行 UID 不决定管理权。删除必须显式带 `--yes`，不提供隐式确认或批量清空；删除一个应用不会删除安装控制账号、密钥或其他应用。重要数据先做一致性备份，AI 不应自行决定永久删除。

宿主机可从任意目录使用 `devctl apps list`、`devctl apps status demo`、`devctl apps logs demo`、`devctl apps start demo`、`devctl apps restart demo`、`devctl apps stop demo`、`devctl apps verify demo` 和 `devctl apps delete demo --yes`。此入口启动一次性受限客户端，不挂载源码、不启动开发容器，源码删除后仍可管理应用。首次使用前需已构建开发镜像。发布新产物仍在开发容器使用 `appctl deploy`。

部署目录包含 `app-deploy.json`：

```json
{
  "command": ["node", "server.mjs"],
  "healthPath": "/health",
  "readyTimeout": 30
}
```

应用保持前台运行，监听分配的 `PORT` 和 `HOST=127.0.0.1`，持久写入使用 `APP_DATA_DIR`。服务镜像提供 Node.js 24、Python 3 和系统工具，不提供任意运行时、容器引擎或交互式 SSH Shell。依赖应在部署前准备好，产物不能包含符号链接、凭据或特殊文件；允许 `.next` 等运行目录。

```bash
appctl deploy demo /workspace/deploy
appctl status demo
appctl verify demo
```

`deploy/start/restart` 的候选失败保留原服务；不保留历史发布版本。新旧进程可能短时共存，数据库迁移、任务消费和其他副作用由应用协调。内部就绪与公网检查分开，HTTP 200 也可能是错误页、登录页或 Cloudflare 质询；发布后仍需检查页面、资源与业务接口。完整契约见 [DEPLOYMENT.md](DEPLOYMENT.md)。

应用崩溃后自动重启，服务容器或宿主机重启后恢复已启用应用。`stop` 后不自动恢复。切换、停止或恢复时已有 WebSocket、SSE 和长请求可能断开，客户端应重连；不承诺无停机。

## 开发环境与服务容器命令

| 命令 | 用途 |
| --- | --- |
| `devctl` | 在当前项目启动 Pi |
| `devctl shell [Bash 参数...]` | 非 root Bash，不安装 provider |
| `devctl stop` | 停止当前开发容器 |
| `devctl down [--all]` | 删除当前或本安装当前用户的开发容器和网络 |
| `devctl ps` | 查看本安装的开发容器 |
| `devctl build [构建参数...]` / `rebuild [...]` | 构建开发镜像 / 无缓存构建 |
| `devctl recreate` | 使用现有镜像重建当前开发容器 |
| `devctl services up / stop / down / ps / logs` | 管理独立服务容器，`down` 保留宿主数据 |
| `devctl services build / recreate` | 构建服务镜像 / 重建服务容器 |

同项目 Pi 会话可并发运行，lease 协调启动和停止；活动会话期间拒绝 `stop/down/recreate`。最后一个会话退出后停止开发容器，不影响应用。不要将原始 `docker exec` 与维护命令混用。

系统依赖加入对应 Dockerfile 后构建；容器可写层不持久，重建会丢失。`services up` 只启动或复用容器；更改服务镜像或配置后显式 `services recreate`，不保证无停机。

## 数据、备份与安全

| 宿主机路径 | 用途 |
| --- | --- |
| 当前项目 | 开发容器 `/workspace`，读写 |
| 仓库 `data/` | 共享 Pi 设置、凭据、扩展与按项目保存的会话 |
| 仓库 `.runtime/` | 开发会话协调锁，不挂载进容器 |
| 仓库 `.deploy-keys/installation/` | 安装 SSH 私钥、控制账号和受信主机密钥，开发容器只读挂载 |
| 仓库 `services-data/`（默认） | 服务容器 `/srv/app-services`，全部部署状态与应用数据 |

默认把可变数据聚合在安装目录，方便整体备份和搬运。开发容器身份仍依赖规范化项目路径；应用管理身份不依赖源码路径。源码搬迁或删除不会注销应用。安装目录移动会改变镜像标签、网络和 Compose 项目名，应先停止旧容器、备份并按新路径重建；不要同时挂载同一份部署状态运行两个服务实例。

服务容器以 root 管理部署目录，内部文件保留每应用数字 UID；宿主机备份、搬运和检查可能需要管理员权限。停服务后完整备份安装目录中的 `.env`、`data/`、`.deploy-keys/` 和 `services-data/`（自定义外部部署目录需额外备份），保留数字 UID/GID、模式和 SSH 主机密钥。数据库需一致性备份，备份应加密；应用管理不要求恢复原源码路径。外部数据库等依赖单独备份。

普通开发会话清空能力集并启用 `no-new-privileges`，拒绝 UID/GID 0。每应用用户不是完整容器隔离：网络、内核和资源仍共享，不托管互不信任代码。日志可能含秘密且会占用磁盘，应控制输出、监控空间。详见 [SECURITY.md](SECURITY.md)。

## 检查

```bash
npm run check              # 源码检查需 Node.js 24；建议安装 ShellCheck、Nginx、OpenSSH
bash tests/docker-smoke.sh  # 仅需本机 Docker 和 Shell 工具，不需宿主机 Node.js
```

冒烟测试使用隔离临时容器、密钥和数据，**不读取真实 `.env`，不验证宿主机 Nginx 或公网**。真实验收应发布一个应用后执行 `appctl verify` 并检查实际内容。

Node 镜像锁定摘要，Pi 使用 npm 锁文件，provider 固定 Git 提交；Debian 系统包接受安全更新。开发镜像 npm 源可通过 `devctl build --build-arg NPM_REGISTRY=...` 覆盖。CI 检查脚本、真实工具回归和容器集成。

## 清理与卸载

### 干净删除一个已部署应用

在任意开发容器中执行，或从宿主机任意目录调用（将 `demo` 换成实际应用名）：

```bash
# 宿主机；不需要先 stop
devctl apps delete demo --yes
devctl apps list
```

收到 `{"app":"demo","state":"deleted","dataPreserved":false}` 且命令成功退出，表示已终止进程、撤下路由，删除该应用在服务端的整个目录（所有产物、隐藏文件、业务数据、日志）和运行登记，并释放应用名。默认位置是 `services-data/apps/demo/`。仅使用 `stop`、开发容器 `down` 或服务容器 `down` 都不会删除这些文件。删除失败时保留可重试状态，不能当作已清理成功。

这不会删除开发项目源码、本地构建目录、共享 Pi 配置、安装控制账号、SSH 密钥或其他应用。`dist/`、`.next/`、`deploy/` 等本地生成目录应由项目自己的清理命令处理，先核对实际输出路径；不要为了删产物删除整个项目，也不要直接修改运行中的服务数据目录。备份、快照、外部数据库和 CDN 缓存需单独处理；文件删除不等于介质安全擦除。

### 删除开发容器或卸载整套工具

| 目的 | 操作与保留边界 |
| --- | --- |
| 删除当前开发容器 | `devctl down`；保留项目文件、共享配置和已部署应用 |
| 删除本安装当前用户的全部开发容器 | `devctl down --all`；保留已部署应用与全部宿主机数据 |
| 删除服务容器 | `devctl services down`；保留部署目录，重新启动可恢复应用 |
| 完全卸载本安装 | 先退出会话、执行上述两种 `down` 并备份，再由管理员核对并删除本安装的软链接、目录和自定义外部数据目录 |

卸载会删除保存在安装目录中的 `.env`、`data/`、`.deploy-keys/`、`services-data/` 等状态，不能与“删除应用产物”混用。容器镜像和构建缓存属于引擎资源，`down` 不删除它们；需要时只移除本安装明确对应的镜像和缓存，不运行会波及其他项目的全局 prune。宿主机 Nginx、DNS 和 TLS 也不由本工具自动删除。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。第三方依赖遵循各自的许可证。
