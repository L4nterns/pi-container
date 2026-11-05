# 应用部署与运维

服务容器提供标准 Debian、SSH/SFTP、sudo、Supervisor 和 Nginx。开发容器使用 `ssh app-services`，宿主机从任意目录使用 `devctl server [Bash 参数...]`。通过标准工具安装所需运行时、执行程序、迁移数据库、排障或传输文件。

## 权限与连接

- `deploy` 是安装共享的管理用户，所有开发项目共同管理应用，没有项目归属限制。
- `deploy` 可通过 `sudo -n` 获得**服务容器内完整 root 权限**。这也意味着可以执行 root Shell；禁止 root SSH 登录不是容器内提权限制。
- 应用使用独立非 root 用户，前台运行。不要使用管理用户或 root 承载应用。
- 开发容器仍启用 no-new-privileges 并清空能力；通过 SSH 登录的是另一容器中的独立进程，不继承客户端的降权状态。服务容器不能启用该选项，否则 sudo 失效。
- SSH 主机密钥由宿主直接登记，严格校验。不开放宿主 SSH 端口，不挂载 Docker socket，不使用 privileged。支持终端和 SFTP，禁用密码、代理及端口转发。

```bash
ssh app-services 'id; sudo -n id'
scp -r /workspace/reviewed-output app-services:upload
sftp app-services
# 宿主机无需原项目目录或开发容器：
devctl server -c 'sudo supervisorctl status'
```

`devctl shell` 与 `devctl server` 都透传 Bash 参数，而非本地 SSH 选项或隐式命令字符串：无参数进入 Shell，`-c '命令'` 执行命令，`-lc '命令'` 使用登录 Shell，`-s` 从 stdin 读取脚本。参数边界和空参数保留；正确引用变量与管道，避免在宿主意外展开。两者都传递标准输入/输出/错误并保留退出码，有终端时分配 TTY，管道和重定向时不分配。开发容器内直接使用的 `ssh app-services` 保持标准 SSH 语义。

## 持久目录与环境恢复

服务端持久状态位于 `/srv/app-services`：

| 路径 | 用途 |
| --- | --- |
| `ssh/`、`control/` | SSH 主机密钥、宿主登记的公钥；不要手工改权限 |
| `setup.d/*.sh` | root 所有且不可被组/其他用户写入的环境准备脚本，按文件名顺序执行 |
| `apps/<name>/` | 应用代码、运行环境、业务数据、日志，按职责分目录 |
| `supervisor/*.conf` | 持久进程定义 |
| `nginx/*.conf` | 持久网关路由定义 |

持久化取决于内容是否需要跨重建保留，不因为某个目录叫 HOME 就挂载。管理用户 HOME 是 `/home/deploy`，用于上传暂存和临时工作，不在持久卷内。需要保留的应用数据、运行产物、配置和密钥按用途放入上述目录；必要的管理配置/工具也应明确选择持久路径，并通过准备脚本链接或恢复。不要依赖 HOME 中的交互式改动、缓存、历史或未审查上传来恢复服务。

安装到 `/usr`、修改 `/etc`、创建用户等写入容器可写层的操作，在**重建**后丢失；仅重启不丢失。将必要步骤记录为幂等的 `setup.d` 脚本，再执行安装。脚本必须在全新容器上也成立，恢复固定 UID/GID，不能每次随机分配，也不要递归改写已有业务数据。

用 SFTP 上传到 HOME 后，通过 sudo 审查并 `install -o root -g root -m 0700` 到临时文件，再在同目录 `mv` 成 `*.sh`。编辑脚本时不要直接覆盖正在使用的文件。共享环境变更用 `sudo flock /run/app-services/change.lock ...` 协调；该锁只协调遵守约定的操作，不是权限边界。

启动顺序：获得持久目录独占锁 → 初始化管理身份 → 执行环境脚本 → 校验 SSH/Nginx → 启动 Supervisor。准备脚本失败会阻止启动并写出诊断，不会假称应用就绪。Supervisor/Nginx 定义必须先通过环境脚本恢复其依赖的用户和目录。

环境脚本执行任意受信任 root 代码，不是安全沙箱。网络安装可能因仓库故障失败；按应用需要固定依赖版本、校验下载来源，并保留可恢复的依赖产物。不要把每次启动都不该执行的数据库迁移或破坏性操作放入自动恢复脚本。

## 按需准备应用

运行时可以是 Python、Node、Java、PHP、Ruby、自包含程序或其他 Debian 可运行程序。服务镜像中的 Python 是 Supervisor/登记工具的管理依赖，不是应用语言限制。不要求应用使用同一基础镜像构建，但其产物必须兼容服务容器的架构、ABI 与系统库。需要 GPU、设备、宿主内核能力或特权的程序，须由管理员另行配置宿主环境。

1. 检查已有应用、端口、用户、运行环境和磁盘空间；不要覆盖同名应用或安装互相冲突的系统依赖。
2. 只传输审查过的运行产物，不上传整个仓库、私钥、令牌、开发缓存、备份或服务数据。SFTP 不会替你扫描秘密或限制包大小。
3. 建立应用独立用户和固定 UID、数据目录。应用代码和启动配置尽量由 root 管理；仅数据/缓存等必要目录授予运行用户写权限。
4. 准备依赖和启动定义；以应用用户执行包安装脚本，不能让不受信任的应用脚本在 sudo 中运行。
5. 先检查内部服务，再发布网关路由，最后验证真实公网与业务。

### 可运行示例

开发镜像提供 `/opt/devctl/skills/app-deployment/examples/python/`，含环境准备脚本、Python 服务、Supervisor 和 Nginx 示例。它演示虚拟环境及非 root 前台进程，不是语言限制。**先审查并按实际情况改应用名、固定 UID、端口和依赖**；示例使用 `demo`、UID/GID 20000、端口 20000，避免与已有应用冲突。Nginx `server_name` 使用明确的已配置域名（示例为 `app-demo.example.com`），需要联调别名时逐一添加，不使用匹配任意后缀的域名正则。

```bash
scp -r /opt/devctl/skills/app-deployment/examples/python app-services:upload
ssh app-services 'sudo -n bash -s' <<'REMOTE'
set -euo pipefail
base=/srv/app-services
stage=/home/deploy/upload
install -o root -g root -m 0700 "$stage/setup.sh" "$base/setup.d/.demo.tmp"
mv "$base/setup.d/.demo.tmp" "$base/setup.d/10-demo.sh"
bash -eu "$base/setup.d/10-demo.sh"
install -o root -g root -m 0644 "$stage/server.py" "$base/apps/demo/code/server.py"
install -o root -g root -m 0600 "$stage/supervisor.conf" "$base/supervisor/demo.conf"
supervisorctl reread
supervisorctl update demo
REMOTE
```

然后用 `ssh app-services 'curl --fail --max-time 5 http://127.0.0.1:20000/'` 检查应用（必要时有界重试，不能把进程存在当作健康）。成功后安装路由：

```bash
ssh app-services 'sudo -n bash -s' <<'REMOTE'
set -euo pipefail
base=/srv/app-services
install -o root -g root -m 0600 "/home/deploy/upload/nginx.conf" "$base/nginx/demo.conf"
nginx -t -c /opt/app-services/nginx.conf
nginx -s reload -c /opt/app-services/nginx.conf
REMOTE
curl --fail --max-time 5 -H 'Host: app-demo.example.com' http://app-services:8080/
```

生产变更应保留上一份配置和产物；验证失败恢复原配置再重载。以上是最小示例，不提供自动事务、数据库回滚或无停机保证。

## 日常管理

```bash
ssh app-services 'sudo supervisorctl status'
ssh app-services 'sudo supervisorctl restart demo'
ssh app-services 'sudo tail -n 100 /srv/app-services/apps/demo/logs/stderr.log'
```

Supervisor 定义使用独立进程组、`stopasgroup=true`、`killasgroup=true`、有限停止时间和日志轮转。示例通过 `setpriv` 在执行应用前切换 UID/GID、清空组和能力并设置 no-new-privileges。应用保持前台，不能自行 daemonize、脱离进程组或依赖 SSH 会话。服务容器的停止宽限期为 30 秒，必须覆盖应用与核心服务的停止预算；需要更长时间的程序应由管理员调整容器配置并验证实际停机，不能把强制终止当作正常关闭。

**`supervisorctl stop` 只影响当前 Supervisor 进程的运行状态。**需要重建后仍停止时，将该程序的持久配置改成 `autostart=false`，再执行 `supervisorctl reread` 和 `supervisorctl update <name>`。同时将其路由移出 `nginx/*.conf` 并校验重载，否则网关可能返回 502。重新启用时改回 `autostart=true`、更新监督器、确认内部健康后恢复路由。

新版本可使用独立发布目录和新端口，健康后切换路由，再停止旧进程；也可在明确接受中断时停止后替换。程序状态、健康和业务正确性是三件事，不能混为一谈。单写数据库、迁移及任务消费的并发副作用由应用协调。

## 网关、联调与公网

HTTP 应用建议只监听服务容器回环地址，使用不冲突的内部端口，通过 Nginx `Host` 路由暴露。非 HTTP 后台任务无需路由；其他协议按实际需要配置内部监听或明确的宿主入口，不能宣称 HTTP 网关支持所有协议。

开发容器联调示例：`curl -H 'Host: app-api.example.com' http://app-services:8080/`。新增 HTTP 应用只改服务容器内的路由文件，不逐项修改宿主 Nginx 或占用新宿主端口。共享路由模板支持 WebSocket 和 SSE，未知应用返回 404；删除或停用应用须撤下路由。

由宿主管理员配置 DNS、TLS 及固定回环上游。宿主参考配置接受 `app-` 加最多 59 字符的小写字母、数字或中划线应用标识（首尾为字母或数字），构成不超过 63 字符的 DNS 标签；这只是该参考入口的命名约定，不是服务容器的应用管理协议。可选 `DEPLOY_PUBLIC_URL=https://app-{app}.example.com` 仅为地址模板，非自动公网验证。部署后用 curl 校验证书、HTTP 状态、页面、资源、API 和长连接。重定向、登录页或 Cloudflare 质询不算业务通过；不要为了测试而关闭 TLS 校验。外部请求转发头只有在宿主可信代理已清洗时才可用于业务信任判断。

## 删除与备份

SSH 管理权限允许直接修改和删除文件；skill 是操作指导，不是权限隔离。**永久删除必须先获得用户明确授权并备份**，授权与备份要求属于操作流程，不由 SSH 命令强制执行。

先持久禁用应用、停止进程并撤下路由，确认无相关进程后，移除对应 Supervisor 配置并更新监督器。逐一核对应用代码/数据/日志路径、环境脚本、运行账号和组，再删除；不要使用模糊通配符、递归追随符号链接或清理共享运行时。中断后先检查实际状态再继续，不宣称具有自动事务恢复。保留安装 SSH 身份及其他应用。

源码、本地构建输出、外部数据库、CDN、快照和备份不属于服务端副本；分别处理。卸载工具、删除容器和删除应用不是同一操作。备份整个持久目录，保留数字 UID/GID、权限和主机密钥；数据库必须一致性备份，备份应加密。
