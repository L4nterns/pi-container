#!/usr/bin/env bash
# Unprivileged, container-local live-process manager. Saved conversations belong
# to Pi; a tmux session here means a RUNNING process, never an inactive history.
set -euo pipefail
# The Debian image provides C.UTF-8: keep deterministic English diagnostics
# without making tmux and the hosted Pi inherit the ASCII-only C locale.
export LC_ALL=C.UTF-8
[[ $(id -u) != 0 ]] || { echo 'Pi 进程不能以 root 运行。' >&2; exit 1; }
name=${2:-}
valid_name() { [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$ ]]; }
[[ -z "$name" ]] || valid_name "$name" || { echo '进程标识无效。' >&2; exit 2; }
TMUX_CMD=(tmux -L pic -f /opt/pic/config/tmux.conf)
# Declare RGB only when the outer terminal explicitly advertises it. Otherwise
# tmux uses TERM/terminfo; do not force a palette or a Pi theme.
case "${COLORTERM:-}" in truecolor|24bit) TMUX_CMD+=(-T RGB) ;; esac
exec 8>>"/tmp/pic-session-$(id -u).lock"
flock -x 8
list_sessions() {
    local result
    if result=$("${TMUX_CMD[@]}" list-sessions -F '#{session_name}|#{session_attached}|#{session_created}' 2>&1); then
        printf '%s\n' "$result" | tr '|' '\t'
    elif [[ "$result" == 'no server running on '* || "$result" == 'no sessions' || "$result" == *'(No such file or directory)' ]]; then return 0
    else printf '%s\n' "$result" >&2; return 1; fi
}
case "${1:-}" in
    list) list_sessions; exit ;;
    count) rows=$(list_sessions); if [[ -z "$rows" ]]; then echo 0; else printf '%s\n' "$rows" | wc -l; fi; exit ;;
    close) valid_name "$name" || exit 2; "${TMUX_CMD[@]}" kill-session -t "=$name"; exit ;;
    start)
        name=${name:-pi-$(date +%Y%m%d-%H%M%S)-$$}
        if "${TMUX_CMD[@]}" has-session -t "=$name" 2>/dev/null; then echo '这个 Pi 已在运行，请从菜单接回。' >&2; exit 1; fi
        # Process hosting only: no --resume/--continue or conversation selection.
        args=()
        if [[ -r /run/pic-ssh/known_hosts ]]; then args+=(--skill /opt/pic/skills/app-deployment); fi
        "${TMUX_CMD[@]}" new-session -d -s "$name" -c /workspace -- pi "${args[@]}" ;;
    attach)
        valid_name "$name" || exit 2
        if ! "${TMUX_CMD[@]}" has-session -t "=$name" 2>/dev/null; then echo '该 Pi 已不在运行，不能接回。可启动并托管 Pi，再在 Pi 内使用 /resume 选择历史。' >&2; exit 1; fi ;;
    *) echo '无效内部进程操作。' >&2; exit 2 ;;
esac
flock -u 8; exec 8>&-
if [[ -t 0 && -t 1 ]]; then
    unset TMUX
    exec "${TMUX_CMD[@]}" attach-session -t "=$name"
fi
printf '%s\n' "$name"
