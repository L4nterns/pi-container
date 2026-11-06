#!/usr/bin/env bash
# Private hosted-Pi launcher; the public pi executable stays native.
set -euo pipefail
[[ $(id -u) != 0 ]] || { echo 'Pi 进程不能以 root 运行。' >&2; exit 1; }
agent_dir=${PI_CODING_AGENT_DIR:-/home/node/.pi/agent}
bootstrap=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/bootstrap-pi.mjs
mode=direct
ready=
case "${1:-}" in
    --hosted) mode=hosted; shift ;;
    --prepared) mode=prepared; ready=${2:?Missing private startup acknowledgment}; shift 2 ;;
esac
for argument in "$@"; do
    if [[ "$argument" == --offline ]]; then export PI_OFFLINE=1; break; fi
done
umask 077
mkdir -p -- "$agent_dir"
# This bind-mounted lock is shared by every project container using the same data.
# Hold a read lease for Pi's entire lifetime, including detached/background work.
exec 9>>"$agent_dir/.pic-packages.lock"
if [[ "$mode" == prepared ]]; then
    flock -s 9
    if ! node "$bootstrap" --check >&2; then printf 'failed\n' > "$ready"; exit 1; fi
    # Parent keeps its shared lease until this child owns one, closing the tmux handoff gap.
    printf 'ready\n' > "$ready"
elif flock -n -x 9; then
    node "$bootstrap" >&2
    flock -s 9
else
    printf '[pic] 共享 Pi 数据仍在使用或初始化中；本次不更新插件。\n' >&2
    flock -s 9
    node "$bootstrap" --check >&2
fi
if [[ "$mode" == hosted ]]; then exec /usr/local/bin/pic-session "$@"; fi
exec pi "$@"
