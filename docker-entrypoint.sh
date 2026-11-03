#!/bin/sh
set -eu

AGENT_DIR="/home/node/.pi/agent"
PLUGIN='git:github.com/L4nterns/pi-provider-newapi@f0cc68fc0caef3da91a77f66a11acc89e7c628e0'
MARKER="$AGENT_DIR/.docker-newapi-installed"

for value in "${PUID:-}" "${PGID:-}"; do
    case "$value" in
        ''|*[!0-9]*) echo '[Pi] PUID/PGID 不合法' >&2; exit 1 ;;
    esac
done
case "${PI_GROUPS:-}" in
    ''|*[!0-9,]*|,*|*,|*,,*) echo '[Pi] PI_GROUPS 不合法' >&2; exit 1 ;;
esac

umask 077
mkdir -p "$AGENT_DIR"
# Serialize ownership changes and package installation across all project containers.
# Release this lock before entering the long-running interactive process.
exec 9>>"$AGENT_DIR/.docker-init.lock"
flock 9
chown "$PUID:$PGID" /home/node /home/node/.pi
find "$AGENT_DIR" -xdev \( ! -uid "$PUID" -o ! -gid "$PGID" \) \
    -exec chown -h "$PUID:$PGID" {} +
chmod 700 "$AGENT_DIR"

if [ "${1:-}" != '--pi-docker-shell' ]; then
    installed=''
    # The marker records the exact source, not a legacy installation format.
    if [ -f "$MARKER" ]; then installed=$(head -n 1 "$MARKER"); fi
    if [ "$installed" != "$PLUGIN" ]; then
        echo '[Pi] 正在安装 pi-provider-newapi...' >&2
        setpriv --reuid "$PUID" --regid "$PGID" --groups "$PI_GROUPS" \
            pi install "$PLUGIN" >&2
        printf '%s\n' "$PLUGIN" > "$MARKER"
        chown "$PUID:$PGID" "$MARKER"
    fi
fi
flock -u 9
exec 9>&-

# A shell initializes ownership but never installs packages or loads the skill.
if [ "${1:-}" = '--pi-docker-shell' ]; then
    shift
    exec setpriv --reuid "$PUID" --regid "$PGID" --groups "$PI_GROUPS" bash "$@"
fi
if [ -n "${VIBE_PUBLIC_URL:-}" ]; then
    set -- --skill /opt/pi-docker/skills/vibe-projects "$@"
fi
exec setpriv --reuid "$PUID" --regid "$PGID" --groups "$PI_GROUPS" pi "$@"
