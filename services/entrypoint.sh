#!/bin/sh
set -eu
umask 077
mkdir -p /srv/app-services/ssh /run/sshd /run/app-services
exec 9>>/srv/app-services/.supervisor.lock
if ! flock -n 9; then
    echo '服务持久目录已由其他服务容器使用' >&2
    exit 1
fi
chown 0:0 /srv/app-services /srv/app-services/ssh
chmod 700 /srv/app-services /srv/app-services/ssh
if [ ! -f /srv/app-services/ssh/ssh_host_ed25519_key ]; then
    ssh-keygen -q -t ed25519 -N '' -f /srv/app-services/ssh/ssh_host_ed25519_key
fi
exec node /opt/app-services/server.mjs
