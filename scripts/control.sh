#!/usr/bin/env bash
# Private operation dispatcher for the terminal menu.
# Not a public CLI; pc and pi-container both open bin/pi-container.
# Maintenance intentionally isolates exported state in subshells.
# shellcheck disable=SC2031
set -euo pipefail
SCRIPT=$(readlink -f -- "${BASH_SOURCE[0]}")
REPO=$(cd -- "$(dirname -- "$SCRIPT")/.." && pwd -P)
# shellcheck source=lib/session-lifecycle.sh
source "$REPO/lib/session-lifecycle.sh"
# shellcheck source=lib/deployment.sh
source "$REPO/lib/deployment.sh"
# shellcheck source=lib/deployment-settings.sh
source "$REPO/lib/deployment-settings.sh"
# shellcheck source=lib/update.sh
source "$REPO/lib/update.sh"
# shellcheck source=lib/idle.sh
source "$REPO/lib/idle.sh"
# shellcheck source=lib/projects.sh
source "$REPO/lib/projects.sh"
WORKDIR=$(pwd -P 2>/dev/null) || WORKDIR=''
UID_VALUE=$(id -u)
HASH=$(printf '%s' "$WORKDIR" | sha256sum | cut -c1-16)
REPO_HASH=$(printf '%s' "$REPO" | sha256sum | cut -c1-8)
PROJECT="pic-r${REPO_HASH}-u${UID_VALUE}-${HASH}"
export PIC_IMAGE="pic:r${REPO_HASH}" PIC_WORKSPACE="${WORKDIR:-/}" PIC_UID="$UID_VALUE"
PIC_GID=$(id -g)
PIC_GROUPS=$(id -G | tr ' ' ',')
if [[ "$UID_VALUE" == 0 ]]; then PIC_UID=1000; PIC_GID=1000; PIC_GROUPS=1000; fi
export PIC_UID PIC_GID PIC_GROUPS
export PIC_HISTORY_DIR="/home/node/.pi/agent/project-history/${UID_VALUE}-${HASH}"
export DEPLOY_IMAGE="app-services:r${REPO_HASH}" DEPLOY_NETWORK="deploy-r${REPO_HASH}"
CORE=(docker compose --project-directory "$REPO" --file "$REPO/compose.yaml" --env-file "$REPO/.env.example")
CURRENT=("${CORE[@]}" --project-name "$PROJECT")
invalid() { printf '无效内部操作；请直接运行 pi-container，在菜单中选择。\n' >&2; exit 2; }
init_lifecycle() { session_lifecycle_init "$REPO/.runtime/$PROJECT"; }
# Docker's TTY default is xterm (8 colors), not the terminal actually attached.
TERMINAL_ENV=(--env "TERM=${TERM:-dumb}" --env "COLORTERM=${COLORTERM:-}" --env "COLORFGBG=${COLORFGBG:-}")
require_existing_container() {
    cid=$("${CURRENT[@]}" ps -q pi) || return
    if [[ -z "$cid" ]]; then printf '当前项目的开发容器不在运行，不能接回 Pi。\n' >&2; return 1; fi
    SESSION_CONTAINER_ID=$cid
}
compose_stop_if_idle() {
    local cid exec_count
    cid=$("${CURRENT[@]}" ps -q pi 2>/dev/null) || return 0
    [[ -n "$cid" ]] || return 0
    [[ -z "${SESSION_CONTAINER_ID:-}" || "$cid" == "$SESSION_CONTAINER_ID" ]] || return 0
    exec_count=$(docker inspect --format '{{len .ExecIDs}}' "$cid" 2>/dev/null) || return 0
    if [[ "$exec_count" == 0 ]] && require_no_live_pi >/dev/null 2>&1; then "${CURRENT[@]}" stop pi >&2 || true; fi
}
finish_session() {
    local status=$?; trap - EXIT
    if pc_operation_lock try; then session_finish compose_stop_if_idle
    else session_release_lease; fi
    exit "$status"
}
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
    # Explicit return codes are essential here: Bash's bare return inside an
    # EXIT trap can reuse the pre-trap (successful) status on a failed query.
    cid=$("${CURRENT[@]}" ps -q pi) || return "$?"
    [[ -n "$cid" ]] || return 0
    # No old-image fallback: missing helper is an error, never proof of idleness.
    count=$(docker exec --user "$PIC_UID:$PIC_GID" "$cid" /usr/local/bin/pic-session count) || return "$?"
    [[ "$count" =~ ^[0-9]+$ ]] || { printf '无法确认运行中 Pi 的状态；拒绝继续。\n' >&2; return 1; }
    if [[ "$count" != 0 ]]; then printf '仍有 %s 个 Pi 进程在运行。请接回后在 Pi 内使用 /quit，或确认中断全部会话。\n' "$count" >&2; return 1; fi
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
confirmed=false
case "$action" in
    dev-stop|dev-remove|dev-remove-all)
        if [[ "${1:-}" == --confirmed-interruption ]]; then confirmed=true; shift; fi ;;
esac
case "$action" in
    project-list)
        (( $# == 0 )) || invalid
        pc_project_list; exit 0 ;;
    project-state|project-logs|project-activity|project-stop|project-remove|project-shell)
        if (( $# != 3 )) || [[ ! "$1" =~ ^pic-r[0-9a-f]{8}-u[0-9]+-[0-9a-f]{16}$ || ! "$2" =~ ^(-|[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127})$ ]]; then invalid; fi
        pc_project_identity "$1" "$3" || invalid
        if [[ "$action" != project-shell ]]; then pc_project_manage "${action#project-}" "$@"; exit 0; fi
        if [[ "$2" != - ]]; then pc_project_shell "$@"; exit "$?"; fi
        pc_project_read "$@" || exit "$?"
        PC_SELECTED_CID=$2
        pc_project_context "$@"
        action=dev-shell; set -- ;;
    tool-check|tool-plan|tool-remove-plan|tool-resource-state|tool-uninstall|dev-activity|dev-all-activity|service-activity)
        (( $# == 0 )) || invalid
        case "$action" in
            tool-check) pc_update_check ;;
            tool-plan) pc_update_inventory ;;
            tool-remove-plan) pc_update_inventory loose ;;
            tool-resource-state) pc_resource_state ;;
            service-activity) pc_service_activity ;;
            tool-uninstall) pc_uninstall ;;
            dev-activity) pc_current_activity ;;
            dev-all-activity) pc_update_inventory dev ;;
        esac
        exit 0 ;;
    service-config-get)
        (( $# == 0 )) || invalid
        deployment_settings_get; exit 0 ;;
    service-config-plan)
        (( $# == 0 )) || invalid
        deployment_recreate_plan; exit 0 ;;
    service-config-apply)
        if (( $# != 1 )) || [[ ! "$1" =~ ^[0-9a-f]{64}$ ]]; then invalid; fi
        deployment_recreate_apply "$1"; exit 0 ;;
    service-config-save)
        if (( $# != 4 )) || [[ ! "$1" =~ ^(missing|[0-9a-f]{64})$ ]]; then invalid; fi
        deployment_settings_save "$@"; exit 0 ;;
    service-state|service-logs|service-running|service-stop|service-remove)
        (( $# == 0 )) || invalid
        deployment_manage_existing "$action"; exit 0 ;;
    tool-update)
        if (( $# != 3 )) || [[ ! "$1" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ || ! "$2" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ || ! "$3" =~ ^(standard|backup)$ ]]; then invalid; fi
        pc_update_apply "$@"; exit 0 ;;
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
        pc_project_state "$cid"
        exit 0 ;;
    dev-logs)
        (( $# == 0 )) || invalid
        "${CURRENT[@]}" logs --no-color --no-log-prefix --tail 200 pi; exit 0 ;;
    pi-attach-state)
        (( $# == 0 )) || invalid
        [[ -n "$WORKDIR" ]] || { printf '当前项目目录不可用。\n' >&2; exit 1; }
        # A menu snapshot only: no lifecycle initialization, dotenv, leases or
        # startup. Unknown/paused states must not masquerade as an empty project.
        cid=$("${CURRENT[@]}" ps -q pi)
        if [[ -z "$cid" ]]; then printf empty; exit 0; fi
        state=$(docker inspect --format '{{.State.Status}}' "$cid")
        [[ "$state" == running ]] || { printf '无法确认可接回的 Pi；容器状态：%s\n' "$state" >&2; exit 1; }
        count=$(docker exec --user "$PIC_UID:$PIC_GID" "$cid" /usr/local/bin/pic-session count)
        [[ "$count" =~ ^[0-9]+$ ]] || { printf '无法确认运行中 Pi 的数量。\n' >&2; exit 1; }
        if [[ "$count" =~ ^0+$ ]]; then printf empty; else printf available; fi
        exit 0 ;;
    pi-running)
        (( $# == 0 )) || invalid
        init_lifecycle; session_lifecycle_lock
        cid=$("${CURRENT[@]}" ps -q pi)
        [[ -n "$cid" ]] || exit 0
        docker exec --user "$PIC_UID:$PIC_GID" "$cid" /usr/local/bin/pic-session list
        session_lifecycle_unlock
        exit 0 ;;
    dev-remove-all)
        (( $# == 0 )) || invalid
        pc_operation_lock
        projects=$(managed_projects | sort -u); status=0; removed=0; skipped=0
        if [[ -z "$projects" ]]; then printf '「无需清理」暂无开发容器。\n'; exit 0; fi
        while IFS= read -r name; do
            [[ -n "$name" ]] || continue
            CURRENT=("${CORE[@]}" --project-name "$name")
            cid=$("${CURRENT[@]}" ps -aq pi) || { status=1; continue; }
            [[ -n "$cid" ]] || continue
            directory=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}' "$cid") || { status=1; continue; }
            printf '项目（宿主路径）：%s\n' "${directory:-未确认}"
            session_lifecycle_init "$REPO/.runtime/$name" || { printf '无法准备维护锁；未删除此容器。\n' >&2; status=1; continue; }
            if [[ "$confirmed" == true ]]; then
                session_lifecycle_lock
                if "${CURRENT[@]}" down --remove-orphans; then removed=$((removed + 1)); printf '「已删除」挂载数据保留。\n'
                else status=1; skipped=$((skipped + 1)); printf '「未删除」请检查上方诊断。\n' >&2; fi
                session_lifecycle_unlock
            elif session_require_idle idle_action "${CURRENT[@]}" down --remove-orphans; then
                removed=$((removed + 1)); printf '「已删除」挂载数据保留。\n'
            else skipped=$((skipped + 1)); status=1; printf '「已跳过」占用、状态未知或删除失败；容器保留。\n'; fi
        done <<< "$projects"
        if (( status )); then printf '\n「清理未完成」已删除 %s 个，保留／未完成 %s 个；挂载数据保留。\n' "$removed" "$skipped"
        else printf '\n「清理完成」已删除 %s 个开发容器；挂载数据保留。\n' "$removed"; fi
        exit "$status" ;;
    dev-remove|dev-stop)
        (( $# == 0 )) || invalid
        pc_operation_lock
        init_lifecycle
        if [[ "$confirmed" == true ]]; then
            session_lifecycle_lock
            if [[ "$action" == dev-stop ]]; then "${CURRENT[@]}" stop pi
            else "${CURRENT[@]}" down --remove-orphans; fi
            session_lifecycle_unlock
        elif [[ "$action" == dev-stop ]]; then session_require_idle idle_action "${CURRENT[@]}" stop pi
        else session_require_idle idle_action "${CURRENT[@]}" down --remove-orphans; fi
        exit 0 ;;
    dev-build|dev-rebuild)
        pc_operation_lock
        build_flags=(); [[ "$action" != dev-rebuild ]] || build_flags+=(--no-cache)
        "${CURRENT[@]}" build "${build_flags[@]}" "$@" pi
        printf '「镜像构建完成」请通过「检查更新」统一应用；现有容器仍使用原镜像。\n'
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
    service-start) (( $# == 0 )) || invalid ;;
    *) invalid ;;
esac
case "$action" in service-app-list) ;; *) pc_operation_lock ;; esac
if [[ ( -z "$WORKDIR" || "$WORKDIR" == / ) && "$action" != service-* ]]; then printf '当前项目目录不可用，或为宿主机根目录 /；请进入具体项目目录。\n' >&2; exit 2; fi
if [[ "$action" == pi-connect ]]; then
    # Attach to the existing process only: no Compose up, deployment setup,
    # credential staging or package bootstrap. Keep the ordinary terminal lease.
    init_lifecycle; trap finish_session EXIT
    session_start require_existing_container
    pc_idle_monitor_start
    pc_operation_unlock
    tty_flags=(-i); [[ ! -t 0 || ! -t 1 ]] || tty_flags=(-it)
    docker exec "${tty_flags[@]}" "${TERMINAL_ENV[@]}" --user "$PIC_UID:$PIC_GID" --workdir /workspace \
        "$cid" /usr/local/bin/pic-session attach "$1"
    exit 0
fi
ENV_FILE="$REPO/.env"; [[ -f "$ENV_FILE" ]] || ENV_FILE="$REPO/.env.example"
COMPOSE=(docker compose --project-directory "$REPO" --project-name "$PROJECT" --file "$REPO/compose.yaml" --env-file "$ENV_FILE")
if [[ "$action" != service-shell ]]; then deployment_config; fi
if [[ "$action" == service-shell ]]; then
    DEPLOY_CREDENTIAL_DIR=$(deployment_connection)
    export DEPLOY_CREDENTIAL_DIR
    pc_require_image development
    tty_flags=(); [[ ! -t 0 || ! -t 1 ]] || tty_flags=(-it)
    pc_operation_unlock
    (( ${#tty_flags[@]} )) || tty_flags=(-i)
    docker run --rm --init --pull never "${tty_flags[@]}" "${TERMINAL_ENV[@]}" --security-opt no-new-privileges --network "$DEPLOY_NETWORK" \
        --label "io.pi-container.installation=$REPO_HASH" --label "io.pi-container.user=$UID_VALUE" --label io.pi-container.role=service-terminal \
        --mount "type=bind,source=$DEPLOY_CREDENTIAL_DIR,target=/run/deploy-credentials,readonly" \
        --tmpfs /run/pic-ssh:rw,noexec,nosuid,nodev,mode=0700 \
        --env "PIC_UID=$PIC_UID" --env "PIC_GID=$PIC_GID" --env "PIC_GROUPS=$PIC_GROUPS" \
        --entrypoint /usr/local/bin/pic-entrypoint "$PIC_IMAGE" --service-shell "$@"
    exit $?
fi
if [[ "$action" == service-* ]]; then
    deployment_require_config; exec {services_fd}>>"$REPO/.services.lock"; flock -x "$services_fd"
    case "$action" in
        service-start)
            deployment_check_existing
            pc_require_image service; deployment_prepare_data
            "${SERVICE_COMPOSE[@]}" up -d --wait --no-recreate --no-build services ;;
        service-build|service-rebuild)
            build_flags=(); [[ "$action" != service-rebuild ]] || build_flags+=(--no-cache)
            "${SERVICE_COMPOSE[@]}" build "${build_flags[@]}" "$@" services
            printf '「镜像构建完成」请通过「检查更新」统一应用；现有容器仍使用原镜像。\n' ;;
        service-app-list|service-app-set)
            cid=$("${SERVICE_COMPOSE[@]}" ps -q services)
            [[ -n "$cid" ]] || { printf '服务容器未运行；请先选择「启动容器」。未自动启动或修改应用。\n' >&2; exit 1; }
            if [[ "$action" == service-app-list ]]; then
                docker exec --user 0 "$cid" /usr/local/bin/deploy-apps list
            else docker exec --user 0 "$cid" /usr/local/bin/deploy-apps set "$@"; fi ;;
    esac; exit 0
fi
deployment_require_workspace
# Optional deployment access never starts/waits for services or blocks Pi on a
# failed connection. Keep this subshell out of a conditional (errexit semantics).
set +e
deployment_optional_connection
connection_status=$?
set -e
if (( connection_status )); then printf '「部署连接未就绪」未启动服务；继续开发环境，服务诊断见上方。\n' >&2; fi
pc_require_image development
mkdir -p -- "$REPO/data"; init_lifecycle
EXEC_TTY=(); [[ -t 0 && -t 1 ]] || EXEC_TTY=(-T)
compose_start() {
    if [[ "${PC_SELECTED_CID:-}" == - ]]; then
        pc_project_read "$PROJECT" - "$WORKDIR" || return
        [[ -d "$WORKDIR" && "$(realpath -e -- "$WORKDIR")" == "$WORKDIR" ]] || { printf '项目目录不存在或已变成别名；未创建容器。\n' >&2; return 1; }
    fi
    "${COMPOSE[@]}" up -d --no-recreate --no-build pi >&2 || return
    if [[ "$UID_VALUE" == 0 ]]; then "${COMPOSE[@]}" exec -T pi /usr/local/bin/pic-workspace-init "$PIC_UID" >&2 || return; fi
    SESSION_CONTAINER_ID=$("${COMPOSE[@]}" ps -q pi)
}
if [[ "$action" == dev-recreate ]]; then
    session_require_idle idle_action "${COMPOSE[@]}" up -d --force-recreate --no-build pi
else
    trap finish_session EXIT; session_start compose_start
    pc_idle_monitor_start
    pc_operation_unlock
    case "$action" in
        dev-shell) "${COMPOSE[@]}" exec "${EXEC_TTY[@]}" "${TERMINAL_ENV[@]}" --workdir /workspace pi /usr/local/bin/pic-entrypoint --dev-shell "$@" ;;
        pi-start) "${COMPOSE[@]}" exec "${EXEC_TTY[@]}" "${TERMINAL_ENV[@]}" --workdir /workspace pi /usr/local/bin/pic-entrypoint --pic-session start "$@" ;;
    esac
fi
