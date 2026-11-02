#!/bin/sh
set -eu

AGENT_DIR="/home/node/.pi/agent"
PLUGIN='git:github.com/L4nterns/pi-provider-newapi'
MARKER="$AGENT_DIR/.docker-newapi-fork-installed"

case "${PUID:-}:${PGID:-}" in
    *[!0-9:]*|:*|*:) echo '[Pi] PUID/PGID 不合法' >&2; exit 1 ;;
esac

mkdir -p "$AGENT_DIR"
chown "$PUID:$PGID" /home/node /home/node/.pi
find "$AGENT_DIR" -xdev \( ! -uid "$PUID" -o ! -gid "$PGID" \) \
    -exec chown -h "$PUID:$PGID" {} +

# 普通 Shell 复用权限初始化，但不触发 Pi 扩展安装。
if [ "${1:-}" = "--pi-docker-shell" ]; then
    shift
    exec setpriv --reuid "$PUID" --regid "$PGID" --groups "$PI_GROUPS" \
        bash "$@"
fi

# 多个项目容器共享 Pi 配置，首次安装扩展必须串行。
exec 9>"$AGENT_DIR/.docker-newapi.lock"
flock 9
if [ ! -f "$MARKER" ]; then
    echo '[Pi] 正在安装 L4nterns/pi-provider-newapi...'
    setpriv --reuid "$PUID" --regid "$PGID" --groups "$PI_GROUPS" \
        pi install "$PLUGIN"
    if [ -f "$AGENT_DIR/.docker-newapi-plugin-installed" ]; then
        setpriv --reuid "$PUID" --regid "$PGID" --groups "$PI_GROUPS" \
            pi remove npm:pi-provider-newapi
    fi
    setpriv --reuid "$PUID" --regid "$PGID" --groups "$PI_GROUPS" \
        touch "$MARKER"
fi
flock -u 9
exec 9>&-

# 仅在配置网站发布功能时加载内置 Skill。
if [ -n "${VIBE_PUBLIC_URL:-}" ]; then
    set -- --skill /opt/pi-docker/skills/vibe-projects "$@"
fi

exec setpriv --reuid "$PUID" --regid "$PGID" --groups "$PI_GROUPS" \
    pi "$@"
