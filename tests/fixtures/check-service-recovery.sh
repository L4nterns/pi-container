#!/bin/bash
# Run as deploy after recreating the service, through the normal SSH client.
set -euo pipefail
[[ "$(id -u)" == 19000 && "$HOME" == /home/deploy ]]
[[ ! -e ~/staging-proof && ! -e ~/upload ]]
# Startup creates root-owned proof with umask 077. Validate through sudo;
# making the file readable by deploy would hide the permission regression.
[[ "$(sudo -n stat -c '%u:%g:%a' /etc/environment-proof)" == 0:0:600 ]]
[[ "$(sudo -n cat /etc/environment-proof)" == restored ]]
[[ "$(sudo -n cat /srv/app-services/apps/demo/data/starts)" -ge 3 ]]
