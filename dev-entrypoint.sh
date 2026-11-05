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
# Validate each numeric group, not just the comma-separated string. Group 0 is
# not part of any development session, including those started by host root.
old_ifs=$IFS
IFS=,
for group in $DEV_GROUPS; do
    case "$group" in 0|0[0-9]*) echo '[devctl] DEV_GROUPS 不合法' >&2; exit 1 ;; esac
done
IFS=$old_ifs

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

# The host mount stays read-only with its original owner/modes, including
# root:root/0600 keys. Stage only what OpenSSH needs into container-local tmpfs.
if [ -d /run/deploy-credentials ]; then
    install -d -m 0711 -o 0 -g 0 /run/devctl-ssh
    for name in id_ed25519 known_hosts; do
        temporary=$(mktemp /run/devctl-ssh/.credential.XXXXXXXX)
        if ! install -m 0600 -o "$DEV_UID" -g "$DEV_GID" "/run/deploy-credentials/$name" "$temporary"; then
            rm -f "$temporary"
            exit 1
        fi
        mv -fT "$temporary" "/run/devctl-ssh/$name"
    done
fi

if [ "${1:-}" != '--dev-shell' ] && [ "${1:-}" != '--service-shell' ]; then
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

if [ "${1:-}" = '--service-shell' ]; then
    shift
    # OpenSSH joins command arguments into shell text. Quote each Bash argument
    # explicitly so spaces, empty strings and metacharacters survive that hop.
    # Variables below expand in the unprivileged Bash, not this initializer.
    # shellcheck disable=SC2016
    exec setpriv --reuid "$DEV_UID" --regid "$DEV_GID" --groups "$DEV_GROUPS" --no-new-privs --inh-caps=-all --ambient-caps=-all --bounding-set=-all bash -c '
        command="exec bash"
        if (( $# )); then
            printf -v arguments " %q" "$@"
            command+=$arguments
        fi
        tty=-T
        if [[ -t 0 && -t 1 ]]; then tty=-t; fi
        exec ssh "$tty" app-services "$command"
    ' bash "$@"
fi
# A shell initializes identity/ownership but never installs packages.
if [ "${1:-}" = '--dev-shell' ]; then
    shift
    exec setpriv --reuid "$DEV_UID" --regid "$DEV_GID" --groups "$DEV_GROUPS" --no-new-privs --inh-caps=-all --ambient-caps=-all --bounding-set=-all bash "$@"
fi
if [ -r /run/devctl-ssh/known_hosts ]; then
    set -- --skill /opt/devctl/skills/app-deployment "$@"
fi
exec setpriv --reuid "$DEV_UID" --regid "$DEV_GID" --groups "$DEV_GROUPS" --no-new-privs --inh-caps=-all --ambient-caps=-all --bounding-set=-all pi "$@"
