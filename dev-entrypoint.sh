#!/bin/sh
set -eu

AGENT_DIR="/home/node/.pi/agent"
PLUGIN='git:github.com/L4nterns/pi-provider-newapi@f0cc68fc0caef3da91a77f66a11acc89e7c628e0'
MARKER="$AGENT_DIR/.devctl-newapi-installed"

for value in "${DEV_UID:-}" "${DEV_GID:-}"; do
    case "$value" in
        ''|*[!0-9]*|0*) echo '[devctl] DEV_UID/DEV_GID 不合法；会话必须使用非 root UID/GID' >&2; exit 1 ;;
    esac
done
case "${DEV_GROUPS:-}" in
    ''|*[!0-9,]*|,*|*,|*,,*) echo '[devctl] DEV_GROUPS 不合法' >&2; exit 1 ;;
esac

umask 077
mkdir -p "$AGENT_DIR"
# Serialize identity/ownership setup and package installation across project containers.
# Release this lock before entering the long-running interactive process.
exec 9>>"$AGENT_DIR/.devctl-init.lock"
flock 9
# Numeric setpriv identities alone are not enough: OpenSSH and other NSS-aware
# tools require a passwd record. Keep the image's node account aligned with the
# host identity, reusing an existing primary group rather than duplicating GIDs.
if ! getent group "$DEV_GID" >/dev/null; then
    groupadd --gid "$DEV_GID" "dev-g${DEV_GID}"
fi
if [ "$(id -u node)" != "$DEV_UID" ] || [ "$(id -g node)" != "$DEV_GID" ]; then
    usermod --uid "$DEV_UID" --gid "$DEV_GID" node
fi
export HOME=/home/node USER=node LOGNAME=node
chown "$DEV_UID:$DEV_GID" /home/node /home/node/.pi
find "$AGENT_DIR" -xdev \( ! -uid "$DEV_UID" -o ! -gid "$DEV_GID" \) \
    -exec chown -h "$DEV_UID:$DEV_GID" {} +
chmod 700 "$AGENT_DIR"

if [ "${1:-}" != '--dev-shell' ] && [ "${1:-}" != '--appctl' ]; then
    installed=''
    # The installation marker records the exact source.
    if [ -f "$MARKER" ]; then installed=$(head -n 1 "$MARKER"); fi
    if [ "$installed" != "$PLUGIN" ]; then
        echo '[devctl] 正在安装 pi-provider-newapi...' >&2
        setpriv --reuid "$DEV_UID" --regid "$DEV_GID" --groups "$DEV_GROUPS" --no-new-privs --inh-caps=-all --ambient-caps=-all --bounding-set=-all \
            pi install "$PLUGIN" >&2
        printf '%s\n' "$PLUGIN" > "$MARKER"
        chown "$DEV_UID:$DEV_GID" "$MARKER"
    fi
fi
flock -u 9
exec 9>&-

if [ "${1:-}" = '--appctl' ]; then
    shift
    exec setpriv --reuid "$DEV_UID" --regid "$DEV_GID" --groups "$DEV_GROUPS" --no-new-privs --inh-caps=-all --ambient-caps=-all --bounding-set=-all node /opt/devctl/bin/appctl.mjs "$@"
fi
# A shell initializes identity/ownership but never installs packages.
if [ "${1:-}" = '--dev-shell' ]; then
    shift
    exec setpriv --reuid "$DEV_UID" --regid "$DEV_GID" --groups "$DEV_GROUPS" --no-new-privs --inh-caps=-all --ambient-caps=-all --bounding-set=-all bash "$@"
fi
if [ -r /run/deploy-credentials/user ]; then
    set -- --append-system-prompt /opt/devctl/deployment-prompt.md "$@"
fi
exec setpriv --reuid "$DEV_UID" --regid "$DEV_GID" --groups "$DEV_GROUPS" --no-new-privs --inh-caps=-all --ambient-caps=-all --bounding-set=-all pi "$@"
