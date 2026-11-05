# devctl · 容器化开发与应用运维

使用 `devctl` 在当前项目中运行 [Pi Coding Agent](https://github.com/earendil-works/pi)，通过普通 SSH/SFTP 管理独立的 Debian 服务容器。应用不依赖开发终端、Pi 会话、开发容器或原源码目录存活。

```text
宿主 devctl ──Docker/Compose──→ 开发容器与独立服务容器
开发容器 ──SSH / SFTP──→ 服务容器（Debian、sudo、Supervisord、Nginx）
公网 HTTPS ──宿主 Nginx──→ 127.0.0.1:18080 ──→ 各应用
```

一个安装实例共享一个服务容器，支持多个应用，不是每应用一个容器。项目间共享管理权限；单一受信任用户模型，不模拟多租户授权，也不是恶意代码沙箱。

## 环境要求与安装

- Linux、Bash 4.1+、GNU coreutils、`flock` 和 OpenSSH 客户端。
- 本机 Docker Engine / Compose v2，支持 `config --environment`、`up --wait`；未验证 Podman。
- 非 root 宿主用户，具有 Docker 权限，安装目录与项目目录可写。
- 公网访问需已有宿主 Nginx、DNS 和 TLS。WSL 使用 Linux 环境；不支持原生 PowerShell 或远程 Docker 引擎。

```bash
git clone https://github.com/L4nterns/pi-docker.git ~/devctl
cd ~/devctl
cp .env.example .env    # 已有 .env 时只编辑，不覆盖
mkdir -p ~/.local/bin
ln -s "$(pwd -P)/bin/devctl" ~/.local/bin/devctl
cd ~/projects/my-app
devctl
```

确保 `~/.local/bin` 位于 PATH，不覆盖未知同名命令。工作区挂载为 `/workspace`；禁止从根目录、安装目录或包含安装秘密/部署状态的父目录启动开发会话。宿主 `pi` 不受影响，容器中的 `pi` 是上游 CLI。

首次构建开发镜像并安装固定提交的 [NewAPI provider](https://github.com/L4nterns/pi-provider-newapi)。在 Pi 使用 `/newapi-provider-add newapi`、`/login newapi`、`/model` 配置。开发镜像使用官方 Node 镜像运行 Pi；服务镜像直接基于 `debian:trixie-slim`，按应用需要通过 SSH 安装运行时与系统依赖。基础镜像锁定摘要、Pi 使用锁文件、provider 固定 Git 提交；Debian 包接受安全更新，构建和依赖安装需要网络。

## 配置

工具安装目录中的 `.env`：

```dotenv
DEPLOY_DATA_DIR=./services-data
DEPLOY_PORT=18080
DEPLOY_PUBLIC_URL=https://app-{app}.example.com
```

| 配置 | 含义 |
| --- | --- |
| `DEPLOY_DATA_DIR` | 部署持久目录，始终相对安装目录解析；留空禁用部署。允许独立外部目录；安装目录内仅允许 `./services-data` |
| `DEPLOY_PORT` | 服务 HTTP 网关的宿主固定回环端口，默认 18080，不对公网直接绑定 |
| `DEPLOY_PUBLIC_URL` | 可选公网地址模板，不配置 DNS/TLS，也不自动验证公网 |

缺失部署目录自动以 0700 创建，现有目录不由宿主工具递归改权。`DEV_*`、镜像标签、网络及会话位置由工具生成；`PI_CODING_AGENT_SESSION_DIR` 是 Pi 上游变量。不要将 `.env` 当 Shell 脚本执行。

## 命令

| 命令 | 用途 |
| --- | --- |
| `devctl` | 当前项目运行 Pi |
| `devctl shell [Bash 参数...]` | 非 root 开发 Shell，不安装 provider |
| `devctl server [Bash 参数...]` | 从任意目录 SSH 连接独立服务容器，不挂载源码、不启动开发容器；省略参数进入服务容器 Shell |
| `devctl stop` | 停止空闲开发容器 |
| `devctl down [--all]` | 删除当前或本安装当前用户的空闲开发容器，保留数据与应用 |
| `devctl ps` | 查看开发容器 |
| `devctl build / rebuild [构建参数...]` | 构建 / 无缓存构建开发镜像 |
| `devctl recreate` | 使用现有镜像重建空闲开发容器 |
| `devctl services up / stop / down / ps / logs / build / recreate` | 服务容器生命周期，down 保留 bind 数据 |

`shell` 与 `server` 统一透传 Bash 参数，均保留 stdin、stdout、stderr 与退出码；有终端时分配 TTY，管道和重定向时不分配。执行命令用 `-c`，登录 Shell 用 `-lc`，读取脚本用 `-s`：

```bash
devctl shell -c 'npm test'
devctl server -c 'sudo supervisorctl status'
devctl shell -s < script.sh
devctl server -s < script.sh
```

独立使用 `devctl server` 前需已有开发镜像，可先 `devctl build`。多会话使用 lease 协调；活动会话期间拒绝 stop/down/recreate，最后一个会话退出只停止开发容器。不要将原始 `docker exec` 与维护命令混用。

不同安装路径有独立镜像标签、网络和 Compose 名称，镜像标签不是版本号。移动安装应先停容器并备份，再在新路径重建；移动源码不影响应用管理。同一服务目录不能同时由两个实例使用。

## 应用部署与运维

部署与排障由 **`app-deployment` skill 按需指导**，也可用 `/skill:app-deployment`；完整流程见 [DEPLOYMENT.md](DEPLOYMENT.md)。开发容器直接使用标准工具：

```bash
ssh app-services 'id; sudo -n id'
scp -r /workspace/reviewed-output app-services:upload
sftp app-services
# 宿主机无需原源码目录：
devctl server -c 'sudo supervisorctl status'
```

SSH 私钥只读挂载，主机公钥由宿主直接登记，不采用首次连接盲目信任。支持终端与普通命令，无应用管理命令白名单。共享管理用户可在**服务容器内无限制 sudo，包括 root Shell**；应用应使用独立非 root 身份。开发容器仍降权并启用 no-new-privileges；服务容器为了 sudo 不启用该限制。没有 Docker socket、privileged、额外 SYS_ADMIN 能力或宿主 cgroup 挂载。详见 [SECURITY.md](SECURITY.md)。

必要的系统包、运行时、用户账号和目录创建写成幂等的持久准备脚本，服务重建时恢复。Supervisord 管理前台进程和崩溃重启；Nginx 提供共享 HTTP 网关。支持安装不同语言运行时，但产物须兼容容器架构、ABI 和系统库；共享依赖冲突须协调。GPU、设备和特权负载需要额外宿主配置，不由 SSH 部署自动授予。

`supervisorctl stop` 不持久化禁用状态：重建后仍需停止时，保存 `autostart=false`，reread/update，并撤下路由。Supervisor 启动反复失败可能进入 FATAL；检查日志和依赖后再启动，不把进程状态当作健康。更新不保证无停机或数据库自动回滚。

## 网关与公网

参考 [config/nginx-apps.conf](config/nginx-apps.conf)，由管理员替换 `example.com` 并复用证书、可信代理配置和 `$connection_upgrade` map，检查后重载宿主 Nginx。工具不会修改现有站点。

`*.example.com` DNS/证书可覆盖 `app-demo.example.com`，`app-*` 本身不是 DNS 泛域名。服务内每应用增加一个路由即可，不逐个改宿主 Nginx 或增加宿主端口。未知域名返回 404，支持 WebSocket/SSE；其他协议按需配置，不宣称 HTTP 网关能代理所有程序。

先检查内部 HTTP，再验证真实 HTTPS 的页面、资源、API 与长连接。内部成功、监督器 RUNNING 或 HTTP 200 不代表公网业务正确；不要把登录页、重定向或 Cloudflare 质询当验收通过。

## 持久化、备份与删除

| 宿主路径 | 内容 |
| --- | --- |
| `data/` | 共享 Pi 配置、凭据、扩展和按项目保存的会话 |
| `.deploy-keys/installation/` | 安装 SSH 私钥与受信主机公钥 |
| `.runtime/` | 开发容器协调锁，不挂载进容器 |
| `services-data/` 或配置的外部目录 | SSH 身份、准备脚本、应用产物/业务数据/日志、Supervisor/Nginx 定义 |

**持久化按内容的恢复价值决定，而不是按目录名决定。**管理用户 HOME `/home/deploy` 不挂载，上传暂存、缓存和交互式工作文件随容器重建丢弃。应用数据、审查后的运行产物、必要配置和 SSH 身份才保存在部署目录；系统依赖与账号通过准备脚本恢复。确需保留的管理配置或工具，应明确选择其持久路径并记录恢复方式，不将整个 HOME 默认纳入备份。

不要提交或公开上述状态与 `.env`；工作区不能覆盖它们或其父目录。环境准备脚本、启动定义和数据持久化，容器可写层中的临时安装不跨重建保留。脚本恢复失败时服务启动失败；通过 `devctl services logs` 诊断，再由宿主管理员修复持久脚本或恢复备份。

备份完整状态，保留数字 UID/GID、权限与 SSH 主机密钥。停服务或使用应用一致性备份，数据库单独做一致性备份；备份应加密。日志与业务数据需监控空间，监督器不是每应用资源配额系统。

**永久删除应用必须先获得明确授权和必要备份。**先持久禁用并停止进程、撤路由，再核对并删除该应用的配置、代码、数据、日志、准备脚本和运行账号；不删除共享管理身份或其他应用。SSH 管理权限允许直接删除文件，授权要求属于操作流程，不由命令强制执行；删除也没有原子性保证。操作失败后检查实际状态，不冒称已清理。

源码、本地构建输出、外部数据库、备份、快照和 CDN 缓存需分别处理。删除文件不等于安全擦除；删除应用、容器与卸载环境是三件事。

卸载前退出会话，执行 `devctl down --all`、`devctl services down`，备份后由管理员核对删除本安装目录、软链接和自定义外部数据。不要运行影响其他项目的全局 Docker prune。

## 检查

```bash
npm ci --ignore-scripts
npm run check
bash tests/docker-smoke.sh
```

源码检查使用 Node.js 24，建议安装 Python 3、ShellCheck 和 OpenSSH。Docker smoke 仅需 Docker 与 Shell 工具，使用临时状态，不读取真实 `.env`、不映射宿主端口、不验证公网。CI 执行源码、真实工具回归及 Docker 集成；完整环境检查方式见测试文件中的 `TEST_SERVICE_ROOTFS` 入口。

## 许可证

[MIT](LICENSE)。第三方依赖遵循各自许可证。
