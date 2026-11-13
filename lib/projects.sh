#!/usr/bin/env bash
# Project targets are short-lived Docker snapshots, never a second registry.
# Every selected operation carries the project name, exact CID and bind source.
pc_project_identity() {
    local name=$1 directory=$2 hash
    [[ "$directory" == /* && "$directory" != / && ! "$directory" =~ [[:cntrl:]] ]] || return 1
    hash=$(printf '%s' "$directory" | sha256sum | cut -c1-16) || return
    [[ "$name" == "pic-r${REPO_HASH}-u${UID_VALUE}-${hash}" ]]
}
pc_project_changed() {
    printf '项目容器或挂载已变化，请返回项目列表重新选择；未操作替代容器。\n' >&2
    return 75
}
pc_project_read() {
    local name=$1 expected=$2 directory=$3 observed labels data source
    pc_project_identity "$name" "$directory" || { pc_project_changed; return "$?"; }
    observed=$("${CORE[@]}" --project-name "$name" ps -aq pi) || return
    [[ "${observed:--}" == "$expected" ]] || { pc_project_changed; return "$?"; }
    PC_PROJECT_CID=$observed PC_PROJECT_STATE=missing
    [[ -n "$observed" ]] || return 0
    labels=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}{{printf "\t"}}{{index .Config.Labels "com.docker.compose.project"}}{{printf "\t"}}{{index .Config.Labels "com.docker.compose.service"}}' "$observed") || return
    source=$(pc_update_mount "$observed" /workspace) || return
    data=$(pc_update_mount "$observed" /home/node/.pi/agent) || return
    [[ "$labels" == "$REPO"$'\t'"$name"$'\t'pi && "$source" == "$directory" && "$data" == "$REPO/data" ]] || { pc_project_changed; return "$?"; }
    PC_PROJECT_STATE=$(docker inspect --format '{{.State.Status}}' "$observed") || PC_PROJECT_STATE=unknown
}
pc_project_context() {
    PROJECT=$1 WORKDIR=$3
    HASH=${PROJECT##*-}
    export PIC_WORKSPACE="$WORKDIR" PIC_HISTORY_DIR="/home/node/.pi/agent/project-history/${UID_VALUE}-${HASH}"
    CURRENT=("${CORE[@]}" --project-name "$PROJECT")
}
pc_project_list() (
    local projects name cid directory current='' others='' row state
    projects=$(managed_projects | sort -u) || return
    while IFS= read -r name; do
        [[ -n "$name" ]] || continue
        cid=$("${CORE[@]}" --project-name "$name" ps -aq pi) || return
        [[ -n "$cid" && "$cid" != *$'\n'* ]] || { pc_project_changed; return "$?"; }
        directory=$(pc_update_mount "$cid" /workspace) || return
        pc_project_read "$name" "$cid" "$directory" || return
        state=$(container_status "$cid") || return
        printf -v row '%s\t%s\t%s\t%s\n' "$name" "$cid" "$state" "$directory"
        if [[ "$name" == "$PROJECT" ]]; then current=$row; else others+=$row; fi
    done <<< "$projects"
    # An uncreated current directory is an explicit candidate, not a resource.
    # Listing never parses dotenv, prepares images, creates leases or data.
    if [[ -z "$current" && -n "$WORKDIR" && -d "$WORKDIR" && "$WORKDIR" != / ]]; then
        if (DEPLOY_DATA_DIR='' deployment_require_workspace) >/dev/null 2>&1; then
            cid=$("${CURRENT[@]}" ps -aq pi) || return
            [[ -z "$cid" ]] || { pc_project_changed; return "$?"; }
            printf -v current '%s\t-\t未创建\t%s\n' "$PROJECT" "$WORKDIR"
        fi
    fi
    printf '%s%s' "$current" "$others"
)
pc_project_state() {
    local cid=$1 state built current
    state=$(container_status "$cid") || return
    status_table '项目（宿主路径）' "$WORKDIR" "$state"
    printf '\n工具源码：'; git -C "$REPO" describe --always --dirty 2>/dev/null || printf '源码包\n'
    built=$(docker image inspect --format '{{.Id}}' "$PIC_IMAGE" 2>/dev/null) || built=''
    if [[ -n "$cid" ]]; then
        current=$(docker inspect --format '{{.Image}}' "$cid") || return
        if [[ -z "$built" ]]; then printf '项目镜像：尚未构建或无法确认\n'
        elif [[ "$current" == "$built" ]]; then printf '项目镜像：已是当前构建\n'
        else printf '项目镜像：有新构建，选择「检查更新」统一应用\n'; fi
        if [[ "$(docker inspect --format '{{.State.Status}}' "$cid")" == running ]]; then
            printf '托管 Pi：'; docker exec --user "$PIC_UID:$PIC_GID" "$cid" /usr/local/bin/pic-session count || printf '未确认\n'
            printf 'Pi 版本：'; docker exec --user "$PIC_UID:$PIC_GID" "$cid" pi --version || printf '未确认\n'
            printf 'Gateway 提交：'
            docker exec --user "$PIC_UID:$PIC_GID" "$cid" git -C /home/node/.pi/agent/git/github.com/L4nterns/pi-provider-gateway rev-parse --short HEAD 2>/dev/null || printf '未确认，请用「pi list」查看\n'
        fi
    elif [[ -n "$built" ]]; then printf '项目镜像：已构建，进入管理终端时创建容器\n'
    else printf '项目镜像：尚未构建或无法确认\n'; fi
}
pc_project_manage() {
    local operation=$1; shift
    pc_project_read "$@" || return
    pc_project_context "$@"
    case "$operation" in
        state) pc_project_state "$PC_PROJECT_CID" ;;
        logs)
            printf '项目：%s\n' "$WORKDIR"
            if [[ -n "$PC_PROJECT_CID" ]]; then docker logs --tail 200 "$PC_PROJECT_CID"
            else printf '「暂无日志」开发容器未创建。\n'; fi ;;
        activity)
            printf '项目：%s\n' "$WORKDIR"
            if [[ -n "$PC_PROJECT_CID" ]]; then pc_show_activity "$PC_PROJECT_CID" "$PROJECT" "$PC_PROJECT_STATE"
            else printf '开发容器未创建。\n'; fi ;;
        stop|remove)
            pc_operation_lock || return
            init_lifecycle || return
            session_lifecycle_lock || return
            pc_project_read "$@" || return
            if [[ -z "$PC_PROJECT_CID" ]]; then printf '「无需操作」开发容器未创建。\n'; return 0; fi
            if [[ "$operation" == stop && ( "$PC_PROJECT_STATE" == exited || "$PC_PROJECT_STATE" == created ) ]]; then
                printf '「无需操作」开发容器已停止；可写层及挂载数据保留。\n'; return 0
            fi
            [[ "$PC_PROJECT_STATE" != paused ]] || docker unpause "$PC_PROJECT_CID" || return
            docker stop --time 30 "$PC_PROJECT_CID" || return
            if [[ "$operation" == remove ]]; then
                docker rm "$PC_PROJECT_CID" || return
                printf '「已删除」所选项目的开发容器；挂载数据保留。\n'
            else printf '「已停止」所选项目的开发容器；可写层及挂载数据保留。\n'; fi ;;
    esac
}
pc_project_shell_start() {
    local host_identity container_identity
    pc_project_read "$PROJECT" "$PC_SELECTED_CID" "$WORKDIR" || return
    DEPLOY_DATA_DIR='' deployment_require_workspace || return
    [[ -d "$WORKDIR" && "$(realpath -e -- "$WORKDIR")" == "$WORKDIR" ]] || { printf '项目目录不存在或已变成别名；未进入终端。\n' >&2; return 1; }
    host_identity=$(stat -Lc '%d:%i' -- "$WORKDIR") || return
    case "$PC_PROJECT_STATE" in
        exited|created) docker start "$PC_SELECTED_CID" >&2 || return; PC_PROJECT_STARTED=true ;;
        running) ;;
        *) printf '容器状态未就绪：%s；未创建替代容器，请检查后重试。\n' "$PC_PROJECT_STATE" >&2; return 1 ;;
    esac
    # A deleted/recreated host path can retain its spelling while the existing
    # container still holds the old bind inode. Never enter that stale workspace.
    container_identity=$(docker exec --user 0 "$PC_SELECTED_CID" stat -Lc '%d:%i' -- /workspace) || return
    [[ "$host_identity" == "$container_identity" && "$host_identity" == "$(stat -Lc '%d:%i' -- "$WORKDIR")" ]] || {
        printf '项目目录已被替换，与容器实际工作区不同；未进入终端，请核对后重新选择。\n' >&2; return 1
    }
    if [[ "$UID_VALUE" == 0 ]]; then docker exec "$PC_SELECTED_CID" /usr/local/bin/pic-workspace-init "$PIC_UID" >&2 || return; fi
    pc_project_read "$PROJECT" "$PC_SELECTED_CID" "$WORKDIR"
}
pc_project_shell() {
    local status=0 PC_PROJECT_STARTED=false
    pc_operation_lock || return
    pc_project_context "$@"
    # Session cleanup and the idle observer consume this exact container ID.
    # shellcheck disable=SC2034
    PC_SELECTED_CID=$2 SESSION_CONTAINER_ID=$2
    init_lifecycle || return
    trap finish_session EXIT
    if session_start pc_project_shell_start; then :; else status=$?; fi
    # A failed entry must not add an observer to a previously running container.
    # If this request actually started it, normal conservative idle rules apply.
    if (( status == 0 )) || [[ "$PC_PROJECT_STARTED" == true ]]; then pc_idle_monitor_start; fi
    (( status == 0 )) || return "$status"
    pc_operation_unlock
    local -a tty_flags=(-i)
    [[ ! -t 0 || ! -t 1 ]] || tty_flags=(-it)
    docker exec "${tty_flags[@]}" "${TERMINAL_ENV[@]}" --workdir /workspace "$PC_SELECTED_CID" /usr/local/bin/pic-entrypoint --dev-shell
}
