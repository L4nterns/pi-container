#!/bin/bash
# Example only: adapt name, UID, dependencies and paths before deployment.
set -euo pipefail
umask 022
if [[ "$(dpkg-query -W -f='${db:Status-Status}' python3-venv 2>/dev/null || true)" != installed ]]; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3-venv
fi
app=/srv/app-services/apps/demo
if ! getent group app-demo >/dev/null; then groupadd --gid 20000 app-demo; fi
[[ "$(getent group app-demo | cut -d: -f3)" == 20000 ]] || { echo 'Conflicting application group' >&2; exit 1; }
if ! getent passwd app-demo >/dev/null; then
    useradd --uid 20000 --gid app-demo --home-dir "$app" --no-create-home --shell /usr/sbin/nologin app-demo
fi
[[ "$(getent passwd app-demo | cut -d: -f3-4,6-7)" == "20000:20000:$app:/usr/sbin/nologin" ]] || { echo 'Conflicting application account' >&2; exit 1; }
install -d -m 0755 "$app" "$app/code"
install -d -m 0700 "$app/logs"
install -d -m 0700 -o app-demo -g app-demo "$app/data"
# The runtime is installed as root, never execute user-writable code as root.
if [[ ! -x "$app/venv/bin/python3" ]]; then python3 -m venv --without-pip "$app/venv"; fi
