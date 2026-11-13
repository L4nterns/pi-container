#!/usr/bin/env bash
# Host-side administration only. No container-engine access is delegated to apps.
deployment_config() {
    local config line
    config=$("${COMPOSE[@]}" config --environment) || return
    DEPLOY_DATA_DIR=
    DEPLOY_PUBLIC_URL=
    DEPLOY_PORT=18080
    while IFS= read -r line; do
        case "$line" in
            DEPLOY_DATA_DIR=*) DEPLOY_DATA_DIR=${line#*=} ;;
            DEPLOY_PUBLIC_URL=*) DEPLOY_PUBLIC_URL=${line#*=} ;;
            DEPLOY_PORT=*) DEPLOY_PORT=${line#*=} ;;
        esac
    done <<< "$config"
    # All relative paths are installation-relative, never caller-project-relative.
    if [[ -n "$DEPLOY_DATA_DIR" ]]; then
        if [[ "$DEPLOY_DATA_DIR" != /* ]]; then DEPLOY_DATA_DIR="$REPO/$DEPLOY_DATA_DIR"; fi
        DEPLOY_DATA_DIR=$(realpath -m -- "$DEPLOY_DATA_DIR") || return
    fi
    export DEPLOY_DATA_DIR DEPLOY_PUBLIC_URL DEPLOY_PORT
    export DEPLOY_IMAGE="app-services:r${REPO_HASH}"
    export DEPLOY_NETWORK="deploy-r${REPO_HASH}"
    # Consumed by the private operation dispatcher.
    # shellcheck disable=SC2034
    SERVICE_COMPOSE=(docker compose --project-directory "$REPO" --project-name "app-services-r${REPO_HASH}"
        --file "$REPO/compose.services.yaml" --env-file "$ENV_FILE")
}

deployment_require_workspace() {
    local protected
    [[ -z "$DEPLOY_DATA_DIR" ]] || deployment_require_data_path || return "$?"
    # A project bind mount must never expose shared credentials or service data.
    # Check even when publishing is disabled and before creating any directories.
    for protected in "$REPO/data" "$REPO/.deploy-keys" "$REPO/.runtime" "$REPO/services-data" "$REPO/.env" "$REPO/.update.lock" "$DEPLOY_DATA_DIR"; do
        [[ -n "$protected" ]] || continue
        protected=$(realpath -m -- "$protected") || return
        if [[ "$WORKDIR" == "$protected" || "$WORKDIR" == "$protected/"* || "$protected" == "$WORKDIR/"* ]]; then
            printf '工作区不能包含或位于共享凭据、运行状态或部署数据目录中。\n' >&2
            return 1
        fi
    done
}

deployment_require_config() {
    if [[ -z "$DEPLOY_DATA_DIR" ]]; then
        printf '请先在「服务管理 → 部署配置」启用部署并设置数据目录。\n' >&2
        return 1
    fi
    deployment_require_data_path || return "$?"
    if [[ ! "$DEPLOY_PORT" =~ ^[0-9]{4,5}$ ]] || (( 10#$DEPLOY_PORT < 1024 || 10#$DEPLOY_PORT > 65535 )); then
        printf 'DEPLOY_PORT 须为 1024–65535。\n' >&2
        return 1
    fi
}

deployment_require_data_path() {
    if [[ "$DEPLOY_DATA_DIR" == / || "$DEPLOY_DATA_DIR" == "$REPO" || "$REPO" == "$DEPLOY_DATA_DIR/"* ||
          ( "$DEPLOY_DATA_DIR" == "$REPO/"* && "$DEPLOY_DATA_DIR" != "$REPO/services-data" ) ]]; then
        printf '安装目录内仅允许 ./services-data；也可使用独立的外部目录。\n' >&2
        return 1
    fi
}

deployment_prepare_data() {
    # Explicit host-side creation only for start/recreate, never status or app policy reads.
    # Compose must not silently create a root-owned bind source.
    (umask 077; mkdir -p -- "$DEPLOY_DATA_DIR") || return
    [[ -d "$DEPLOY_DATA_DIR" ]] || return 1
}

deployment_existing_container() {
    local cid
    cid=$(pc_managed_services) || return "$?"
    [[ "$cid" != *$'\n'* ]] || { printf '发现多个共享服务容器，请核对后重试。\n' >&2; return 1; }
    printf '%s' "$cid"
}

deployment_running_container() {
    local cid state
    cid=$(deployment_existing_container) || return "$?"
    [[ -n "$cid" ]] || return 0
    state=$(docker inspect --format '{{.State.Status}}' "$cid") || return "$?"
    [[ "$state" != running ]] || printf '%s' "$cid"
}

deployment_port_binding() {
    docker inspect --format '{{with index .HostConfig.PortBindings "8080/tcp"}}{{range .}}{{.HostIp}}:{{.HostPort}}{{end}}{{end}}' "$1"
}

deployment_check_existing() {
    local cid data binding
    cid=$(deployment_existing_container) || return "$?"
    [[ -n "$cid" ]] || return 0
    data=$(pc_update_mount "$cid" /srv/app-services) || return "$?"
    binding=$(deployment_port_binding "$cid") || return "$?"
    if [[ "$data" != "$DEPLOY_DATA_DIR" || "$binding" != "127.0.0.1:$DEPLOY_PORT" ]]; then
        printf '「部署配置待应用」现有服务的数据目录或端口与配置不同；未启动或替换容器。\n实际数据：%s\n配置数据：%s\n实际端口：%s\n配置端口：127.0.0.1:%s\n选择「服务管理 → 启动容器」或保存「部署配置」，检查差异并确认重建；不会自动搬移数据。\n' "$data" "$DEPLOY_DATA_DIR" "$binding" "$DEPLOY_PORT" >&2
        return 1
    fi
}

deployment_show_activity() {
    local cid=$1 state=$2 ids
    printf '共享服务容器：%s · %s；确认重建会中断全部应用及连接。\n' "$cid" "$state"
    if [[ "$state" == running ]]; then
        docker exec --user 0 "$cid" supervisorctl -c /opt/app-services/supervisord.conf status || printf '应用状态无法完整读取，状态未知；确认继续仍会中断。\n'
        printf '进程（PID／用户／名称，含 SSH 会话；不显示命令参数）：\n'
        docker top "$cid" -eo pid,user,comm || printf 'SSH／进程状态无法完整读取，状态未知；确认继续仍会中断。\n'
    elif [[ "$state" != exited && "$state" != created ]]; then
        printf '应用及 SSH 状态无法确认；确认继续仍会中断，重建后不启动。\n'
    fi
    ids=$(docker inspect --format '{{range .ExecIDs}}{{println .}}{{end}}' "$cid") || ids=未知
    printf 'Docker exec／终端连接 ID：\n%s\n' "${ids:-无}"
    printf '清单为当前快照；确认涵盖该服务的全部连接，包括新连接和状态未知的连接。\n'
}

deployment_manage_existing() (
    set -euo pipefail
    local action=$1 cid state services_fd networks network
    case "$action" in
        service-stop|service-remove)
            pc_operation_lock
            exec {services_fd}>>"$REPO/.services.lock"; flock -x "$services_fd" ;;
    esac
    cid=$(deployment_existing_container)
    if [[ "$action" == service-running ]]; then
        if [[ -n "$cid" ]]; then state=$(docker inspect --format '{{.State.Status}}' "$cid"); else state=missing; fi
        if [[ "$state" == running ]]; then printf running; else printf stopped; fi
        exit 0
    fi
    if [[ "$action" == service-state ]]; then
        state=$(container_status "$cid"); status_table '服务容器' '应用服务' "$state"
        if [[ -n "$cid" ]]; then
            printf '\n实际持久数据：'; pc_update_mount "$cid" /srv/app-services
            docker inspect --format '恢复策略：{{.HostConfig.RestartPolicy.Name}}' "$cid"
        fi
        exit 0
    fi
    if [[ -n "$cid" ]]; then
        if [[ "$action" == service-logs ]]; then docker logs --tail 200 "$cid"; exit 0; fi
        state=$(docker inspect --format '{{.State.Status}}' "$cid")
        if [[ "$action" == service-stop && ( "$state" == exited || "$state" == created ) ]]; then
            printf '「无需操作」服务容器已停止；可写层及挂载数据保留。\n'; exit 0
        fi
        [[ "$state" != paused ]] || docker unpause "$cid"
        docker stop --time 30 "$cid"
        if [[ "$action" == service-remove ]]; then docker rm "$cid"
        else printf '「已停止」服务容器；可写层及挂载数据保留。\n'; fi
    else
        if [[ "$action" == service-logs ]]; then printf '「暂无日志」服务容器未创建。\n'
        else printf '「无需操作」服务容器未创建。\n'; fi
        exit 0
    fi
    if [[ "$action" == service-remove ]]; then
        networks=$(docker network ls -q --filter "label=com.docker.compose.project=app-services-r${REPO_HASH}")
        while IFS= read -r network; do [[ -z "$network" ]] || docker network rm "$network"; done <<< "$networks"
        printf '「已删除」服务容器；挂载数据保留。\n'
    fi
)

deployment_connection() (
    # Connection preparation has no service lifecycle side effects. Even when
    # invoked by Pi startup it must never call up, build, wait or prepare_data.
    set -euo pipefail
    local mode=${1:-required} credentials host_key cid service_fd deploy_fd
    umask 077
    exec {service_fd}>>"$REPO/.services.lock"
    if [[ "$mode" == optional ]]; then flock -n -x "$service_fd" || exit 0
    else flock -x "$service_fd"; fi
    cid=$(deployment_running_container)
    if [[ "$mode" == optional && -n "$cid" ]]; then
        deployment_require_config
        deployment_check_existing
    fi
    if [[ -z "$cid" ]]; then
        if [[ "$mode" == optional ]]; then exit 0; fi
        printf '服务容器未运行；请先选择「启动容器」。未自动启动服务。\n' >&2
        exit 1
    fi
    credentials="$REPO/.deploy-keys/installation"
    mkdir -p -- "$credentials"
    exec {deploy_fd}>>"$credentials/provision.lock"
    flock -x "$deploy_fd"
    if [[ ! -f "$credentials/id_ed25519" ]]; then
        ssh-keygen -q -t ed25519 -N '' -f "$credentials/id_ed25519"
    fi
    host_key=$(docker exec --user 0 "$cid" /usr/local/bin/deploy-register \
        "$(<"$credentials/id_ed25519.pub")")
    if [[ ! "$host_key" =~ ^ssh-ed25519\ [A-Za-z0-9+/]+={0,2}$ ]]; then
        printf '服务 SSH 主机密钥不合法，未更新信任记录。\n' >&2
        exit 1
    fi
    # Atomic replacement prevents concurrent SSH clients reading a partial key.
    # Base64-shaped text is not necessarily a valid SSH public-key structure.
    printf '[app-services]:2222 %s\n' "$host_key" > "$credentials/known_hosts.tmp"
    if ! ssh-keygen -l -f "$credentials/known_hosts.tmp" >/dev/null 2>&1; then
        rm -f -- "$credentials/known_hosts.tmp"
        printf '服务 SSH 主机密钥不合法，未更新信任记录。\n' >&2
        exit 1
    fi
    mv -- "$credentials/known_hosts.tmp" "$credentials/known_hosts"
    printf '%s' "$credentials"
)

deployment_optional_connection() {
    local credentials status
    [[ -n "$DEPLOY_DATA_DIR" ]] || return 0
    # The caller temporarily disables errexit, but this assignment MUST remain
    # outside an if/|| condition: Bash otherwise disables it inside connection.
    credentials=$(deployment_connection optional)
    status=$?
    (( status == 0 )) || return "$status"
    if [[ -n "$credentials" ]]; then
        export DEPLOY_CREDENTIAL_DIR=$credentials
        COMPOSE+=(--file "$REPO/compose.deploy.yaml")
    fi
}
