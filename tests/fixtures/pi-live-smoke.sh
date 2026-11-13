#!/bin/sh
# Test-only hosted process. Never stand in for Pi's package-management CLI.
set -eu
case "${1:-}" in
    ''|--skill) ;;
    *)
        printf 'Synthetic smoke Pi only hosts a live process; real CLI/bootstrap must finish before replacing Pi.\n' >&2
        exit 97 ;;
esac
printf '%s\n' "$$" > "${PIC_SMOKE_PID_FILE:-/tmp/live-pi-pid}"
exec sleep infinity
