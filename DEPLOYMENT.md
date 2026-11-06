# 应用部署与运维

这是 Pi in Container 的可选能力：一个安装共享一个独立 Debian 服务容器，由 Supervisord 管理进程、Nginx 提供 HTTP 网关。应用不依赖 Pi 进程、开发容器或原源码目录存活。

服务端通过标准 SSH/SFTP 管理，不限应用语言。共享管理员 `deploy` 可在**服务容器内无限制免密 sudo，包括 root Shell**；应用应使用各自的非 root 用户。这里不是项目隔离或多租户平台，详见仓库的 [SECURITY.md](SECURITY.md)。

## 启用与连接

编辑安装目录的 `.env`，配置项参考仓库的 [.env.example](.env.example)。启用部署另需宿主 OpenSSH 客户端（`ssh-keygen`），不要将 `.env` 当 Shell 脚本执行：

```dotenv
DEPLOY_DATA_DIR=./services-data
DEPLOY_PORT=18080
DEPLOY_PUBLIC_URL=https://app-{app}.example.com
```

- `DEPLOY_DATA_DIR` 留空禁用部署。相对路径以安装目录为基准；安装目录内仅允许 `./services-data`，也可使用独立外部目录。缺失目录以 0700 创建，不递归改权已有数据。
- `DEPLOY_PORT` 是服务 HTTP 网关的宿主回环端口（1024–65535），不直接绑定公网。
- `DEPLOY_PUBLIC_URL` 是可选地址模板，不自动配置或验证 DNS、TLS 与路由。

运行 `pic`，先在「开发容器管理」构建镜像，再进入「服务容器管理 → SSH 管理终端」。菜单会启动服务并登记 SSH 信任；状态、日志、构建、启动、停止、重建和删除也在同一菜单，不需要记子命令。

SSH 终端是标准 Bash，可输入命令或在终端里执行脚本。它传递标准输入、输出、错误，有交互终端时分配 TTY；不挂载项目源码或 Pi 数据，不启动项目开发容器。

启用部署后进入 Pi，`app-deployment` skill 会按需提供操作指导，也可使用 `/skill:app-deployment`。开发容器中可直接使用：

```bash
ssh app-services 'id; sudo -n id'
scp -r /workspace/reviewed-output app-services:upload
sftp app-services
```

宿主通过 `pic` 的「服务容器管理」菜单管理整个容器。构建只构建镜像，重建使用现有镜像；停止、删除容器和重建均保留部署目录。一个持久目录只能由一个服务实例使用。容器身份按安装路径区分；移动安装前先停容器、备份，再在新路径重建。

## 持久化与恢复

宿主部署目录挂载为 `/srv/app-services`：

| 路径 | 保存内容 |
| --- | --- |
| `ssh/`、`control/` | SSH 主机密钥和宿主登记的公钥 |
| `setup.d/*.sh` | 幂等环境准备脚本，恢复系统包、账号及目录 |
| `apps/<name>/` | 按职责分开的运行产物、环境、业务数据与日志 |
| `supervisor/*.conf` | 应用进程定义 |
| `nginx/*.conf` | HTTP 路由定义 |

**持久化按内容价值决定，不按 HOME 决定。**管理 HOME `/home/deploy` 只是暂存区，重建即丢弃。容器可写层中的系统安装与账号也不跨重建保留；必要配置、工具和依赖须有明确的持久路径或恢复步骤。

启动时按文件名顺序执行环境脚本，再校验 SSH/Nginx 并启动 Supervisor。脚本须由 root 所有、不可被组或其他用户写入，不接受符号链接；发布时用同目录临时文件原子替换。它们是受信任 root 代码，必须可审查、可重复执行，并恢复固定 UID/GID，不能递归重置已有业务数据或自动执行破坏性迁移。

共享变更可用 `sudo flock /run/app-services/change.lock ...` 协调；该锁不是权限边界。准备脚本失败会阻止服务启动，先在「服务容器管理 → 日志」查看错误，必要时由宿主管理员修复持久文件或恢复备份。同一安装的 SSH 客户端身份在 `.deploy-keys/installation/`，也需要备份。

## 发布应用

1. **检查现状**：确认应用名、账号 UID/GID、端口、运行时与磁盘空间，不覆盖已有应用。不同语言的产物须兼容容器架构、ABI 和系统库，共享依赖冲突需要协调；GPU、设备和特权负载不由 SSH 自动授予。
2. **审查产物**：只上传运行所需文件，不整库上传凭据、开发缓存或备份。先暂存 HOME，再用 sudo 安装到持久目录；不要以 root 执行不受信任的应用安装脚本。
3. **准备环境**：将必要系统安装、固定账号与目录创建写入 `setup.d`，验证在全新容器上可恢复。代码与启动配置由管理员控制，仅数据、缓存等目录交给应用用户写入。
4. **启动进程**：写入 Supervisor 定义，执行 `sudo supervisorctl reread`、`sudo supervisorctl update <name>`。应用保持前台，通过 `setpriv` 切换用户、清空附加组和能力、启用 no-new-privileges；不要依赖 SSH 会话。
5. **发布路由**：先验证内部服务，再安装明确域名的 Nginx 路由，校验后重载，最后验收真实公网。变更前保留上一份配置和产物，失败时恢复后再重载。

可参考 [Python 示例](skills/app-deployment/examples/python/) 中的 `setup.sh`、`supervisor.conf`、`nginx.conf` 和 `server.py`；开发镜像中位于 `/opt/pic/skills/app-deployment/examples/python/`。先调整示例应用名 `demo`、UID/GID 20000、端口 20000 和域名；它演示完整配置，不限制应用语言。

服务端校验与重载路由：

```bash
sudo nginx -t -c /opt/app-services/nginx.conf &&
    sudo nginx -s reload -c /opt/app-services/nginx.conf
```

## 运行与停止

在终端菜单的服务 SSH 终端内，查看状态、日志或重启应用：

```bash
sudo supervisorctl status
sudo tail -n 100 /srv/app-services/apps/demo/logs/stderr.log
sudo supervisorctl restart demo
```

Supervisor 定义应设置进程组停止、有限等待时间和日志轮转，参考示例。服务容器的停止宽限期为 30 秒，应用停止预算必须与之匹配。反复启动失败可能进入 FATAL，应检查日志和依赖；RUNNING 不等于健康。监控磁盘与资源，Supervisor 不提供每应用资源配额。

`supervisorctl stop` **不持久保存停止状态**。要在重建后仍停止，保存 `autostart=false`，再 `reread`、`update <name>`；同时将路由移出 `nginx/*.conf` 并校验重载。重新启用时反向操作，先确认内部健康再恢复路由。

更新需自行协调进程切换、单写数据库和迁移，不保证无停机或自动回滚。

## 公网入口与验收

HTTP 应用通常只监听服务容器回环地址，由内部 Nginx 路由转发。开发容器可用 `curl -H 'Host: app-demo.example.com' http://app-services:8080/` 联调；后台任务无需 HTTP 路由，其他协议需要单独规划入口。

宿主管理员参考仓库的 [config/nginx-apps.conf](config/nginx-apps.conf)，配置 DNS、证书和 Nginx，替换 `example.com` 并复用可信代理及连接升级配置。工具不修改宿主站点。`*.example.com` 可覆盖 `app-demo.example.com`，`app-*` 不是 DNS 泛域名。入口配置完成后，新增 HTTP 应用只需增加服务端路由，不逐项增加宿主端口。

先验内部服务，再验证真实 HTTPS 的证书、目标页面、资源、API 和所需的 WebSocket/SSE。未知应用应返回 404；登录页、重定向或 Cloudflare 质询不算业务通过，不关闭 TLS 校验来凑成功。应用只有在可信入口清洗转发头后才能据此作信任判断。

## 备份、删除与卸载

备份部署目录及安装 SSH 身份，保留数字 UID/GID、权限和主机密钥。停服务或使用应用一致性备份，数据库需单独保证一致性，备份应加密。

**永久删除应用前须获得明确授权并做好必要备份。**先持久禁用并停止进程、撤路由，再核对并删除该应用的 Supervisor 定义、产物、数据、日志、准备脚本及账号。不要清理共享运行时、SSH 身份或其他应用；操作中断后核查实际状态，删除不是原子事务。SSH 权限本身不强制授权或备份流程。

源码、外部数据库、CDN、备份和快照需分别处理；文件删除不等于安全擦除。卸载前在菜单结束运行中的 Pi、断开终端，再通过「开发容器管理」删除全部空闲开发容器、通过「服务容器管理」删除服务容器；备份后核对删除本安装的软链接、安装目录及外部数据，不使用全局 Docker prune。
