#!/usr/bin/env bash
# Private operation dispatcher for the terminal menu.
# Not a public CLI; pc and pi-container both open bin/pi-container.
set -euo pipefail
SCRIPT=$(readlink -f -- "${BASH_SOURCE[0]}")
REPO=$(cd -- "$(dirname -- "$SCRIPT")/.." && pwd -P)
# shellcheck source=lib/session-lifecycle.sh
source "$REPO/lib/session-lifecycle.sh"
# shellcheck source=lib/deployment.sh
source "$REPO/lib/deployment.sh"
WORKDIR=$(pwd -P)
UID_VALUE=$(id -u)
HASH=$(printf '%s' "$WORKDIR" | sha256sum | cut -c1-16)
REPO_HASH=$(printf '%s' "$REPO" | sha256sum | cut -c1-8)
PROJECT="pic-r${REPO_HASH}-u${UID_VALUE}-${HASH}"
export PIC_IMAGE="pic:r${REPO_HASH}" PIC_WORKSPACE="$WORKDIR" PIC_UID="$UID_VALUE"
PIC_GID=$(id -g)
PIC_GROUPS=$(id -G | tr ' ' ',')
if [[ "$UID_VALUE" == 0 ]]; then PIC_UID=1000; PIC_GID=1000; PIC_GROUPS=1000; fi
export PIC_UID PIC_GID PIC_GROUPS
export PIC_HISTORY_DIR="/home/node/.pi/agent/project-history/${UID_VALUE}-${HASH}"
CORE=(docker compose --project-directory "$REPO" --file "$REPO/compose.yaml" --env-file "$REPO/.env.example")
CURRENT=("${CORE[@]}" --project-name "$PROJECT")
invalid() { printf '无效内部操作；请直接运行 pi-container，在菜单中选择。\n' >&2; exit 2; }
init_lifecycle() { session_lifecycle_init "$REPO/.runtime/$PROJECT"; }
# Docker's TTY default is xterm (8 colors), not the terminal actually attached.
TERMINAL_ENV=(--env "TERM=${TERM:-dumb}" --env "COLORTERM=${COLORTERM:-}" --env "COLORFGBG=${COLORFGBG:-}")
require_existing_container() {
    cid=$("${CURRENT[@]}" ps -q pi) || return
    if [[ -z "$cid" ]]; then printf '当前项目的开发容器不在运行，不能接回 Pi。\n' >&2; return 1; fi
}
compose_stop_if_idle() {
    local cid exec_count
    cid=$("${CURRENT[@]}" ps -q pi 2>/dev/null) || return 0
    [[ -n "$cid" ]] || return 0
    exec_count=$(docker inspect --format '{{len .ExecIDs}}' "$cid" 2>/dev/null) || return 0
    if [[ "$exec_count" == 0 ]] && require_no_live_pi >/dev/null 2>&1; then "${CURRENT[@]}" stop pi >&2 || true; fi
}
finish_session() { local status=$?; trap - EXIT; session_finish compose_stop_if_idle; exit "$status"; }
managed_projects() {
    local ids id name
    ids=$(docker ps -aq --filter "label=com.docker.compose.project.working_dir=$REPO" --filter 'label=com.docker.compose.service=pi') || return
    while IFS= read -r id; do
        [[ -n "$id" ]] || continue
        name=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$id") || return
        [[ "$name" =~ ^pic-r${REPO_HASH}-u${UID_VALUE}-[0-9a-f]{16}$ ]] || continue
        printf '%s\n' "$name"
    done <<< "$ids"
}
container_status() {
    local cid=$1 state code health
    if [[ -z "$cid" ]]; then printf '未创建'; return; fi
    IFS=$'\t' read -r state code health < <(docker inspect --format '{{.State.Status}}{{printf "\t"}}{{.State.ExitCode}}{{printf "\t"}}{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}' "$cid")
    case "$state" in
        running) printf '运行中'; [[ "$health" == - ]] || printf '（%s）' "$health" ;;
        exited) printf '已停止（退出码 %s）' "$code" ;;
        created) printf '已创建，未启动' ;;
        paused) printf '已暂停' ;;
        restarting) printf '重启中（退出码 %s）' "$code" ;;
        dead) printf '异常终止（退出码 %s）' "$code" ;;
        *) printf '%s' "${state:-状态未确认}" ;;
    esac
}
status_table() {
    local label=$1 value=$2 state=$3 c n label_width=0 value_width=0
    local LC_ALL=C.UTF-8
    for ((n=0; n<${#label}; n++)); do c=${label:n:1}; if [[ "$c" == [\ -~] ]]; then label_width=$((label_width + 1)); else label_width=$((label_width + 2)); fi; done
    for ((n=0; n<${#value}; n++)); do c=${value:n:1}; if [[ "$c" == [\ -~] ]]; then value_width=$((value_width + 1)); else value_width=$((value_width + 2)); fi; done
    local width=$value_width; (( width >= label_width )) || width=$label_width
    printf '%s%*s状态\n%s%*s%s\n' "$label" "$((width - label_width + 2))" '' "$value" "$((width - value_width + 2))" '' "$state"
}
require_no_live_pi() {
    local cid count
    cid=$("${CURRENT[@]}" ps -q pi) || return
    [[ -n "$cid" ]] || return 0
    # No old-image fallback: missing helper is an error, never proof of idleness.
    count=$(docker exec --user "$PIC_UID:$PIC_GID" "$cid" /usr/local/bin/pic-session count) || return
    [[ "$count" =~ ^[0-9]+$ ]] || { printf '无法确认运行中 Pi 的状态；拒绝继续。\n' >&2; return 1; }
    if [[ "$count" != 0 ]]; then printf '仍有 %s 个 Pi 进程在运行。请在 pi-container 菜单中接回或结束它们。\n' "$count" >&2; return 1; fi
}
idle_action() {
    local cid count
    require_no_live_pi || return
    cid=$("${CURRENT[@]}" ps -q pi) || return
    if [[ -n "$cid" ]]; then
        count=$(docker inspect --format '{{len .ExecIDs}}' "$cid") || return
        [[ "$count" == 0 ]] || { printf '容器仍有终端连接；拒绝中断。\n' >&2; return 1; }
    fi
    "$@"
}
action=${1:-}; [[ -n "$action" ]] || invalid; shift
case "$action" in
    dev-list)
        (( $# == 0 )) || invalid
        projects=$(managed_projects | sort -u)
        if [[ -z "$projects" ]]; then printf '「暂无开发容器」本安装、当前用户。\n'; fi
        while IFS= read -r name; do
            [[ -n "$name" ]] || continue
            cid=$("${CORE[@]}" --project-name "$name" ps -aq pi)
            [[ -n "$cid" ]] || continue
            directory=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}' "$cid")
            state=$(container_status "$cid")
            status_table '项目（宿主路径）' "${directory:-未确认}" "$state"
            printf '\n'
        done <<< "$projects"
        exit 0 ;;
    dev-state)
        (( $# == 0 )) || invalid
        cid=$("${CURRENT[@]}" ps -aq pi)
        state=$(container_status "$cid")
        status_table '项目（宿主路径）' "$WORKDIR" "$state"
        printf '\n工具源码：'; git -C "$REPO" describe --always --dirty 2>/dev/null || printf '源码包\n'
        built=$(docker image inspect --format '{{.Id}}' "$PIC_IMAGE" 2>/dev/null) || built=''
        running=$("${CURRENT[@]}" ps -q pi)
        if [[ -n "$cid" ]]; then
            current=$(docker inspect --format '{{.Image}}' "$cid")
            if [[ -z "$built" ]]; then printf '项目镜像：尚未构建或无法确认\n'
            elif [[ "$current" == "$built" ]]; then printf '项目镜像：已是当前构建\n'
            else printf '项目镜像：有新构建，选择「重建容器」应用\n'; fi
        elif [[ -n "$built" ]]; then printf '项目镜像：已构建，启动 Pi 或管理终端时创建容器\n'
        else printf '项目镜像：尚未构建或无法确认\n'; fi
        if [[ -n "$running" ]]; then
            printf '托管 Pi：'; docker exec --user "$PIC_UID:$PIC_GID" "$running" /usr/local/bin/pic-session count || printf '未确认\n'
            printf 'Pi 版本：'; docker exec --user "$PIC_UID:$PIC_GID" "$running" pi --version || printf '未确认\n'
            printf 'Gateway 提交：'
            docker exec --user "$PIC_UID:$PIC_GID" "$running" git -C /home/node/.pi/agent/git/github.com/L4nterns/pi-provider-gateway rev-parse --short HEAD 2>/dev/null || printf '未确认，请用「pi list」查看\n'
        fi
        exit 0 ;;
    dev-logs)
        (( $# == 0 )) || invalid
        "${CURRENT[@]}" logs --no-color --no-log-prefix --tail 200 pi; exit 0 ;;
    pi-running|pi-end)
        if [[ "$action" == pi-end ]]; then
            if (( $# != 1 )) || [[ ! "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$ ]]; then invalid; fi
        else (( $# == 0 )) || invalid; fi
        init_lifecycle; session_lifecycle_lock
        cid=$("${CURRENT[@]}" ps -q pi)
        if [[ -z "$cid" ]]; then [[ "$action" == pi-running ]] && exit 0; printf '没有运行中的 Pi。\n' >&2; exit 1; fi
        if [[ "$action" == pi-running ]]; then
            docker exec --user "$PIC_UID:$PIC_GID" "$cid" /usr/local/bin/pic-session list
        else docker exec --user "$PIC_UID:$PIC_GID" "$cid" /usr/local/bin/pic-session close "$1"; fi
        session_lifecycle_unlock; exit 0 ;;
    dev-remove-all)
        (( $# == 0 )) || invalid
        projects=$(managed_projects | sort -u); status=0
        if [[ -z "$projects" ]]; then printf '「暂无开发容器」本安装、当前用户。\n'; fi
        while IFS= read -r name; do
            [[ -n "$name" ]] || continue
            CURRENT=("${CORE[@]}" --project-name "$name")
            cid=$("${CURRENT[@]}" ps -aq pi) || { status=1; continue; }
            [[ -n "$cid" ]] || continue
            directory=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}' "$cid") || { status=1; continue; }
            printf '项目（宿主路径）：%s\n' "${directory:-未确认}"
            session_lifecycle_init "$REPO/.runtime/$name" || { printf '无法准备维护锁；未删除此容器。\n' >&2; status=1; continue; }
            session_require_idle idle_action "${CURRENT[@]}" down --remove-orphans || status=1
        done <<< "$projects"
        exit "$status" ;;
    dev-remove|dev-stop)
        (( $# == 0 )) || invalid
        init_lifecycle
        if [[ "$action" == dev-stop ]]; then session_require_idle idle_action "${CURRENT[@]}" stop pi
        else session_require_idle idle_action "${CURRENT[@]}" down --remove-orphans; fi
        exit 0 ;;
    dev-build|dev-rebuild)
        build_flags=(); [[ "$action" != dev-rebuild ]] || build_flags+=(--no-cache)
        "${CURRENT[@]}" build "${build_flags[@]}" "$@" pi
        printf '「镜像构建完成」选择「重建容器」应用；现有容器仍使用原镜像。\n'
        exit 0 ;;
    pi-start|pi-connect)
        if (( $# > 1 )) || { (( $# == 1 )) && [[ ! "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$ ]]; }; then invalid; fi
        if [[ "$action" == pi-connect && $# != 1 ]]; then invalid; fi ;;
    dev-recreate) (( $# == 0 )) || invalid ;;
    dev-shell|service-shell) ;;
    service-app-list) (( $# == 0 )) || invalid ;;
    service-app-set)
        if (( $# != 3 )) || [[ ! "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ || ! "$2" =~ ^(true|false)$ || ! "$3" =~ ^[0-9a-f]{64}$ ]]; then invalid; fi ;;
    service-build|service-rebuild) ;;
    service-start|service-stop|service-remove|service-state|service-logs|service-recreate) (( $# == 0 )) || invalid ;;
    *) invalid ;;
esac
if [[ "$WORKDIR" == / && "$action" != service-* ]]; then printf '拒绝将宿主机根目录 / 挂载为工作区；请进入具体项目目录。\n' >&2; exit 2; fi
if [[ "$action" == pi-connect ]]; then
    # Attach to the existing process only: no Compose up, deployment setup,
    # credential staging or package bootstrap. Keep the ordinary terminal lease.
    init_lifecycle; trap finish_session EXIT
    session_start require_existing_container
    tty_flags=(-i); [[ ! -t 0 || ! -t 1 ]] || tty_flags=(-it)
    docker exec "${tty_flags[@]}" "${TERMINAL_ENV[@]}" --user "$PIC_UID:$PIC_GID" --workdir /workspace \
        "$cid" /usr/local/bin/pic-session attach "$1"
    exit 0
fi
ENV_FILE="$REPO/.env"; [[ -f "$ENV_FILE" ]] || ENV_FILE="$REPO/.env.example"
COMPOSE=(docker compose --project-directory "$REPO" --project-name "$PROJECT" --file "$REPO/compose.yaml" --env-file "$ENV_FILE")
deployment_config
if [[ "$action" == service-shell ]]; then
    provision_deployment; tty_flags=(); [[ ! -t 0 || ! -t 1 ]] || tty_flags=(-it)
    (( ${#tty_flags[@]} )) || tty_flags=(-i)
    docker run --rm --init --pull never "${tty_flags[@]}" "${TERMINAL_ENV[@]}" --security-opt no-new-privileges --network "$DEPLOY_NETWORK" \
        --mount "type=bind,source=$DEPLOY_CREDENTIAL_DIR,target=/run/deploy-credentials,readonly" \
        --tmpfs /run/pic-ssh:rw,noexec,nosuid,nodev,mode=0700 \
        --env "PIC_UID=$PIC_UID" --env "PIC_GID=$PIC_GID" --env "PIC_GROUPS=$PIC_GROUPS" \
        --entrypoint /usr/local/bin/pic-entrypoint "$PIC_IMAGE" --service-shell "$@"
    exit $?
fi
if [[ "$action" == service-* ]]; then
    deployment_require_config; exec {services_fd}>>"$REPO/.services.lock"; flock -x "$services_fd"
    case "$action" in
        service-start) deployment_prepare_data; "${SERVICE_COMPOSE[@]}" up -d --wait --no-recreate services ;;
        service-stop) "${SERVICE_COMPOSE[@]}" stop services ;;
        service-remove) "${SERVICE_COMPOSE[@]}" down --remove-orphans ;;
        service-state)
            cid=$("${SERVICE_COMPOSE[@]}" ps -aq services)
            state=$(container_status "$cid"); status_table '服务容器' '应用服务' "$state"
            printf '\n持久数据：%s\n' "$DEPLOY_DATA_DIR"
            if [[ -n "$cid" ]]; then docker inspect --format '恢复策略：{{.HostConfig.RestartPolicy.Name}}' "$cid"
            else printf '恢复策略：unless-stopped（创建容器后生效）\n'; fi ;;
        service-logs) "${SERVICE_COMPOSE[@]}" logs --no-color --no-log-prefix --tail 200 services ;;
        service-build|service-rebuild)
            build_flags=(); [[ "$action" != service-rebuild ]] || build_flags+=(--no-cache)
            "${SERVICE_COMPOSE[@]}" build "${build_flags[@]}" "$@" services
            printf '「镜像构建完成」选择「重建容器」应用；现有容器仍使用原镜像。\n' ;;
        service-recreate) deployment_prepare_data; "${SERVICE_COMPOSE[@]}" up -d --wait --force-recreate --no-build services ;;
        service-app-list|service-app-set)
            cid=$("${SERVICE_COMPOSE[@]}" ps -q services)
            [[ -n "$cid" ]] || { printf '服务容器未运行；请先选择「启动容器」。未自动启动或修改应用。\n' >&2; exit 1; }
            if [[ "$action" == service-app-list ]]; then
                docker exec --user 0 "$cid" /usr/local/bin/deploy-apps list
            else docker exec --user 0 "$cid" /usr/local/bin/deploy-apps set "$@"; fi ;;
    esac; exit 0
fi
deployment_require_workspace
[[ -z "$DEPLOY_DATA_DIR" ]] || provision_deployment
mkdir -p -- "$REPO/data"; init_lifecycle
EXEC_TTY=(); [[ -t 0 && -t 1 ]] || EXEC_TTY=(-T)
compose_start() {
    "${COMPOSE[@]}" up -d --no-recreate pi >&2 || return
    if [[ "$UID_VALUE" == 0 ]]; then "${COMPOSE[@]}" exec -T pi /usr/local/bin/pic-workspace-init "$PIC_UID" >&2 || return; fi
}
if [[ "$action" == dev-recreate ]]; then
    session_require_idle idle_action "${COMPOSE[@]}" up -d --force-recreate --no-build pi
else
    trap finish_session EXIT; session_start compose_start
    case "$action" in
        dev-shell) "${COMPOSE[@]}" exec "${EXEC_TTY[@]}" "${TERMINAL_ENV[@]}" --workdir /workspace pi /usr/local/bin/pic-entrypoint --dev-shell "$@" ;;
        pi-start) "${COMPOSE[@]}" exec "${EXEC_TTY[@]}" "${TERMINAL_ENV[@]}" --workdir /workspace pi /usr/local/bin/pic-entrypoint --pic-session start "$@" ;;
    esac
fi
