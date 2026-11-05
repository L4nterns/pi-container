# 应用部署与管理契约

`appctl` 是本项目提供的应用管理 CLI，不是 Pi 上游功能。通过受限 SSH 将当前项目产物发布到独立服务容器；应用以每应用独立非 root UID 运行，由监督器负责重启和恢复，不依赖开发终端、Pi 会话或开发容器。

## 准备产物

1. 检查构建流程、运行时和入口，不猜测输出目录。
2. 在 `/workspace` 内准备专用部署目录，只包含运行所需内容。不要上传整个仓库、开发缓存、私钥、登录令牌、`.env`、备份或服务端数据。依赖可随产物提供，但符号链接必须在打包时转成实际文件；服务端不执行包安装脚本。
3. 审查文件及嵌入内容。动态程序本身就是代码，自动扫描不能证明安全；协议校验不代替审查。上传期间不要修改目录。
4. 创建 `app-deploy.json`：

   ```json
   {
     "command": ["node", "server.mjs"],
     "healthPath": "/health",
     "readyTimeout": 30,
     "env": {"APP_MODE": "public"}
   }
   ```

`command` 是直接执行的参数数组，不经过 Shell；需要脚本时显式使用 `sh script.sh`。`healthPath` 是本地 HTTP 路径，`readyTimeout` 为 1–120 秒。所有应用遵循相同契约，包括用 HTTP 服务提供页面文件的应用。服务镜像包含 Node.js 24、Python 3、curl；其他系统依赖加入 `services/Dockerfile`，由管理员构建。

保留环境变量：

- `HOST=127.0.0.1`、`PORT`：监听地址与分配端口。
- `APP_DATA_DIR`：持久业务数据目录，不随代码替换删除。
- `HOME`、`USER`、`LOGNAME`：应用运行账号，不是管理权限边界。
- `PATH`：服务端受控的程序搜索路径。

默认 `NODE_ENV=production`；`env` 可设置应用变量，但不能覆盖上述保留变量。运行定义保存在私有部署目录，不是秘密管理系统；不输出或提交真实凭据。应用变量在降权后才加载。

运行目录是可替换的产物目录，业务数据不能写在这里。进程保持前台，不自行 daemonize、`setsid` 或脱离进程组，不依赖 SSH 会话。新旧实例可能短时共存，应用须可在另一端口并行启动。

## 命令

```bash
appctl --help
appctl deploy demo /workspace/deploy
appctl list
appctl status demo
appctl logs demo
appctl stop demo
appctl start demo
appctl restart demo
appctl verify demo
# 仅在用户明确同意永久删除并完成必要备份后：
appctl delete demo --yes
```

| 操作 | 契约 |
| --- | --- |
| `deploy <app> <目录>` | 上传新产物，内部 HTTP 和实际新网关路由通过检查后启用或替换 |
| `list` | 列出本安装所有应用、状态、是否启用、进程是否存在及可选 URL |
| `status <app>` | 额外探测内部 HTTP；`running` 只说明监督进程存在，健康以 `internalHealthy` 为准 |
| `logs <app>` | 读取最多最后 64 KiB，可能从 UTF-8 字符中间截断，不持续跟随 |
| `stop <app>` | 撤路由、持久禁用、终止进程；产物、业务数据、日志和应用名均保留 |
| `start <app>` | 从持久运行定义启用停止的应用；已启用时只返回状态，不上传产物 |
| `restart <app>` | 用现有产物启动候选，通过检查后切换；停止的应用也会启用 |
| `delete <app> --yes` | 撤路由、禁用、终止进程并永久删除所有应用文件及登记，释放应用名 |
| `verify <app>` | 仅在当前客户端请求配置的公网 URL，与服务端生命周期分开 |

应用名为 1–48 位小写字母、数字及内部连字符，服务容器内全局唯一。同一安装的开发项目共享管理权限，允许跨项目调试、更新和联调；每应用 UID 只负责运行隔离。源码目录删除或搬迁不影响应用管理。宿主可从任意目录使用 `devctl apps list/status/logs/start/restart/stop/verify`（除 list 外须指定应用），无需启动开发容器。删除仍须明确授权和 `devctl apps delete <app> --yes`。没有批量清空入口；DNS 和宿主机网关配置不会因删除应用而删除。

上传限制 512 MiB、20,000 个普通文件。拒绝路径穿越、符号链接、特殊文件及 `.git`、`.ssh`、`.env`、`.deploy-keys`、`services-data` 等敏感目录；允许 `.next`、`.bin` 等运行目录。限制不证明产物内容没有秘密或恶意代码。

## 跨项目协作与联调

同一安装的所有项目共享应用管理权。应用名是安装级全局名称；再次 deploy 同名应用会更新该应用，不检查源码目录归属。共同使用的应用应先协调变更，删除仍须明确授权与 `--yes`。

开发容器可通过固定网关联调其他应用，例如 `curl -H 'Host: app-api.internal' http://app-services:8080/`。网关根据 Host 路由，不需要为每个应用添加宿主端口或 Nginx 配置；这里的内部 URL 不代表公网已验证。

## 就绪、状态与恢复

候选使用新端口，经 `healthPath` 探测后切换 Nginx，并确认新请求确实到达候选端口；单凭 `nginx -t` 或 reload 返回不够。`deploy/restart` 失败保留原进程和路由；重新尝试即可，不提供历史版本管理或自动数据库回滚。

`status` 状态包括 `running`、`restarting`、`stopped`、`deleting`。内部就绪不是业务完整验收；应用可能在检查后崩溃。监督器会重启已启用的崩溃应用，服务容器或宿主机重启后恢复启用状态；`stop` 的应用不会自动恢复。

`start/restart` 不重新上传，使用已保存的产物与运行定义。切换可能存在两个进程，数据库迁移、单写数据库、任务消费和其他副作用须自行协调。停止和切换时长连接可能断开，客户端应支持重连，不承诺无停机。

## 公网检查

由管理员设置可选 `DEPLOY_PUBLIC_URL=https://app-{app}.example.com`，配置 DNS、TLS 和宿主机 Nginx。相对部署目录 `DEPLOY_DATA_DIR=./services-data` 以工具安装目录为基准，与 `/workspace` 无关；不要在项目里尝试修改共享服务配置。

`deploy/start/restart` 返回 `publicVerified:false`，不会隐式请求公网。执行：

```bash
appctl verify demo
```

该命令从当前开发容器发起请求，验证 TLS 并输出 HTTP 状态及内容类型；不会将结果写成永久“已验证”状态。网络受限、证书失败、无 URL 配置时明确报告失败，不能虚报公网通过。继续检查页面、JS/CSS、业务 API、WebSocket 或 SSE；HTTP 200 也可能是默认页、登录页或 Cloudflare 质询，3xx 仅说明重定向而非最终内容正确。

应用使用域名根路径，不需要 context path。不要为了发布修改其他应用、共享网关或宿主机服务。

## 删除、备份与安全

`stop` 和 `delete` 不可混淆。永久删除必须获得用户明确授权，并显式使用 `--yes`；备份业务数据后再执行。删除包括运行定义、整个应用目录（所有产物、隐藏文件、`APP_DATA_DIR` 和日志），不保留历史或回收站，不删除安装控制账号与密钥。

```bash
# 在任意项目的开发容器中；无需先 stop
appctl delete demo --yes
appctl list
# 或在宿主机任意目录中调用：
# devctl apps delete demo --yes
# devctl apps list
```

只有命令成功退出并返回 `state: "deleted"` 才能视为服务端清理完成。开发项目中的源码和本地 `dist/`、`.next/`、`deploy/` 等构建输出不属于服务端副本，应通过项目自己的清理流程删除。不要直接 `rm` 运行中的服务目录；外部数据库、备份、快照和 CDN 缓存需单独处理，文件删除不是安全擦除。

删除先确认路由撤下并持久记录 `deleting`，再停止和清理文件，最后删除登记并释放名称。中断时不会重启已部分删除的应用：重试 `delete` 或下次服务启动会完成清理。清理失败时保留 `deleting` 和名称占用，不能冒充删除成功。缺失的应用报错。

服务账号只有受限 SSH 操作，无 Shell、SFTP、任意文件读取或端口转发。日志和业务数据可能含秘密，不原样公开。根目录应完整备份，保留数字 UID/GID、模式和 SSH 主机密钥；数据库需一致性备份。`./services-data` 已从 Git 和镜像构建排除，不作为开发工作区挂载。每应用 UID 不是恶意代码安全沙箱，不同信任边界应使用独立服务实例与数据目录。
