#!/bin/sh
set -eu
umask 077
ROOT=/srv/app-services
[ "$(id -u)" = 0 ] || { echo 'Service initialization requires container root' >&2; exit 1; }
if [ -r /proc/self/status ] && grep -Eq '^NoNewPrivs:[[:space:]]+1$' /proc/self/status; then
    echo 'Service administration needs sudo; do not set no-new-privileges on this container' >&2
    exit 1
fi
mkdir -p "$ROOT"
exec 9>>"$ROOT/.supervisor.lock"
flock -n 9 || { echo 'Service data already in use' >&2; exit 1; }
# Do not change app ownership on restart; setup scripts restore stable accounts.
mkdir -p "$ROOT/ssh" "$ROOT/control" "$ROOT/apps" "$ROOT/setup.d" "$ROOT/supervisor" "$ROOT/nginx" /run/sshd /run/app-services
chown 0:0 "$ROOT" "$ROOT/apps" "$ROOT/ssh" "$ROOT/control" "$ROOT/setup.d" "$ROOT/supervisor" "$ROOT/nginx"
chmod 711 "$ROOT" "$ROOT/apps" "$ROOT/control"
chmod 700 "$ROOT/ssh" "$ROOT/setup.d" "$ROOT/supervisor" "$ROOT/nginx"
if ! getent group deploy >/dev/null; then groupadd --gid 19000 deploy; fi
[ "$(getent group deploy | cut -d: -f3)" = 19000 ] || { echo 'Conflicting deploy group' >&2; exit 1; }
if ! getent passwd deploy >/dev/null; then
    useradd --uid 19000 --gid deploy --create-home --home-dir /home/deploy --shell /bin/bash --password '*' deploy
fi
record=$(getent passwd deploy)
[ "$(printf '%s' "$record" | cut -d: -f3-4,6-7)" = "19000:19000:/home/deploy:/bin/bash" ] || { echo 'Conflicting deploy account' >&2; exit 1; }
# The admin HOME is disposable. Persist application state and reproducible
# environment definitions by purpose, not everything written during a session.
install -d -m 0700 -o deploy -g deploy /home/deploy
# This trusted installation administrator has container-root-equivalent access.
printf '%s\n' 'deploy ALL=(ALL:ALL) NOPASSWD: ALL' > /etc/sudoers.d/deploy
chmod 440 /etc/sudoers.d/deploy
visudo -cf /etc/sudoers.d/deploy
if [ ! -f "$ROOT/ssh/ssh_host_ed25519_key" ]; then
    ssh-keygen -q -t ed25519 -N '' -f "$ROOT/ssh/ssh_host_ed25519_key"
fi
# Setup is trusted administrative code. Keep files root-owned and publish them
# atomically; failed setup aborts startup instead of running a partial environment.
for script in "$ROOT"/setup.d/*.sh; do
    [ -e "$script" ] || [ -L "$script" ] || continue
    [ -f "$script" ] && [ ! -L "$script" ] && [ "$(stat -c %u "$script")" = 0 ] || { echo 'Unsafe setup script' >&2; exit 1; }
    mode=$(stat -c %a "$script")
    [ "$((0$mode & 022))" = 0 ] || { echo 'Setup script is group/world writable' >&2; exit 1; }
    printf 'Preparing environment: %s\n' "${script##*/}"
    /bin/bash -eu "$script"
done
/usr/sbin/sshd -t -f /opt/app-services/sshd_config
nginx -t -c /opt/app-services/nginx.conf
exec supervisord -n -c /opt/app-services/supervisord.conf
