#!/bin/sh
set -eu
status=$(supervisorctl -c /opt/app-services/supervisord.conf status sshd nginx) || exit 1
printf '%s\n' "$status" | awk 'NF { count++; if ($2 != "RUNNING") bad=1 } END { exit (count != 2 || bad) }'
# A dedicated health host must always hit the default 404, not an app route.
code=$(curl --silent --show-error --max-time 2 --output /dev/null --write-out '%{http_code}' \
    -H 'Host: health.invalid' http://127.0.0.1:8080/)
[ "$code" = 404 ]
