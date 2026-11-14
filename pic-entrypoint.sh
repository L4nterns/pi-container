#!/bin/sh
set -eu
AGENT_DIR="/home/node/.pi/agent"
export PI_CODING_AGENT_DIR="$AGENT_DIR"
for value in "${PIC_UID:-}" "${PIC_GID:-}"; do
    case "$value" in ''|*[!0-9]*|0*) echo '[pic] PIC_UID/PIC_GID 不合法；必须使用非 root 身份' >&2; exit 1 ;; esac
done
case "${PIC_GROUPS:-}" in ''|*[!0-9,]*|,*|*,|*,,*) echo '[pic] PIC_GROUPS 不合法' >&2; exit 1 ;; esac
old_ifs=$IFS; IFS=,
for group in $PIC_GROUPS; do case "$group" in 0|0[0-9]*) echo '[pic] PIC_GROUPS 不合法' >&2; exit 1 ;; esac; done
IFS=$old_ifs
umask 077
mkdir -p "$AGENT_DIR"
exec 9>>"$AGENT_DIR/.pic-init.lock"
flock 9
if ! getent group "$PIC_GID" >/dev/null; then groupadd --gid "$PIC_GID" "pic-g${PIC_GID}"; fi
if [ "$(id -u node)" != "$PIC_UID" ] || [ "$(id -g node)" != "$PIC_GID" ]; then usermod --uid "$PIC_UID" --gid "$PIC_GID" node; fi
export HOME=/home/node USER=node LOGNAME=node
chown "$PIC_UID:$PIC_GID" /home/node /home/node/.pi
find "$AGENT_DIR" -xdev \( ! -uid "$PIC_UID" -o ! -gid "$PIC_GID" \) -exec chown -h "$PIC_UID:$PIC_GID" {} +
chmod 700 "$AGENT_DIR"
if [ ! -e "$AGENT_DIR/AGENTS.md" ] && [ ! -L "$AGENT_DIR/AGENTS.md" ] && [ -r /opt/pic/config/AGENTS.md ]; then install -m 0600 -o "$PIC_UID" -g "$PIC_GID" /opt/pic/config/AGENTS.md "$AGENT_DIR/AGENTS.md"; fi
if [ -d /run/deploy-credentials ]; then
    install -d -m 0711 -o 0 -g 0 /run/pic-ssh
    for name in id_ed25519 known_hosts; do
        temporary=$(mktemp /run/pic-ssh/.credential.XXXXXXXX)
        if ! install -m 0600 -o "$PIC_UID" -g "$PIC_GID" "/run/deploy-credentials/$name" "$temporary"; then rm -f "$temporary"; exit 1; fi
        mv -fT "$temporary" "/run/pic-ssh/$name"
    done
fi
if [ "${1:-}" != '--dev-shell' ] && [ "${1:-}" != '--service-shell' ]; then
    setpriv --reuid "$PIC_UID" --regid "$PIC_GID" --groups "$PIC_GROUPS" --no-new-privs --inh-caps=-all --ambient-caps=-all --bounding-set=-all node /opt/pic/scripts/bootstrap-pi.mjs >&2
fi
flock -u 9; exec 9>&-
if [ "${1:-}" = '--service-shell' ]; then
    shift
    # OpenSSH serializes argv as shell text. Quote each argument explicitly.
    # shellcheck disable=SC2016
    exec setpriv --reuid "$PIC_UID" --regid "$PIC_GID" --groups "$PIC_GROUPS" --no-new-privs --inh-caps=-all --ambient-caps=-all --bounding-set=-all bash -c '
        command="exec bash"
        if (( $# )); then printf -v arguments " %q" "$@"; command+=$arguments; fi
        tty=-T; if [[ -t 0 && -t 1 ]]; then tty=-t; fi
        exec ssh "$tty" app-services "$command"
    ' bash "$@"
fi
if [ "${1:-}" = '--dev-shell' ]; then
    shift
    exec setpriv --reuid "$PIC_UID" --regid "$PIC_GID" --groups "$PIC_GROUPS" --no-new-privs --inh-caps=-all --ambient-caps=-all --bounding-set=-all bash "$@"
fi
if [ "${1:-}" = '--pic-session' ]; then
    shift
    exec setpriv --reuid "$PIC_UID" --regid "$PIC_GID" --groups "$PIC_GROUPS" --no-new-privs --inh-caps=-all --ambient-caps=-all --bounding-set=-all /usr/local/bin/pic-session "$@"
fi
if [ -r /run/pic-ssh/known_hosts ]; then set -- --skill /opt/pic/skills/app-deployment "$@"; fi
exec setpriv --reuid "$PIC_UID" --regid "$PIC_GID" --groups "$PIC_GROUPS" --no-new-privs --inh-caps=-all --ambient-caps=-all --bounding-set=-all pi "$@"
