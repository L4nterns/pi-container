#!/usr/bin/env bash
# Loaded before checkout changes; an operation never starts executing half old,
# half newly downloaded host code. No startup fetch, host runtime or global prune.
# ShellCheck is not call-order aware: update intentionally isolates globals.
# shellcheck disable=SC2030,SC2031
pc_update_git() {
    GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false git --literal-pathspecs -c core.hooksPath=/dev/null -C "$REPO" "$@"
}
pc_update_repository() {
    local root
    if ! root=$(pc_update_git rev-parse --show-toplevel 2>/dev/null) || [[ "$root" != "$REPO" ]]; then
        printf '当前安装不是独立 Git 工作区。请按 README 使用公开仓库安装；不会初始化 Git 或覆盖现有数据。\n' >&2
        return 1
    fi
}
pc_update_local_mode() {
    local target=$1 branch changes
    branch=$(pc_update_git symbolic-ref -q HEAD) || branch=detached
    changes=$(pc_update_git status --porcelain --untracked-files=normal) || return
    if [[ "$branch" == refs/heads/main && -z "$changes" ]] && pc_update_git merge-base --is-ancestor HEAD "$target"; then printf standard
    else printf backup; fi
}
pc_update_check() {
    local old target mode
    pc_update_repository || return
    old=$(pc_update_git rev-parse HEAD) || return
    pc_update_git -c credential.helper= -c http.extraHeader= fetch --no-tags --no-recurse-submodules -- \
        https://github.com/L4nterns/pi-container.git '+refs/heads/main:refs/pi-container/update' >&2 || return
    target=$(pc_update_git rev-parse 'refs/pi-container/update^{commit}') || return
    mode=$(pc_update_local_mode "$target") || return
    printf '%s\t%s\t%s\n' "$old" "$target" "$mode"
}
pc_operation_lock() {
    [[ -z "${PC_OPERATION_FD:-}" ]] || return 0
    local mask
    mask=$(umask); umask 077
    exec {PC_OPERATION_FD}>>"$REPO/.update.lock"
    umask "$mask"
    if [[ "${1:-wait}" == try ]]; then
        if flock -n -s "$PC_OPERATION_FD"; then return 0; fi
        pc_operation_unlock; return 1
    fi
    if ! flock -n -s "$PC_OPERATION_FD"; then
        printf '工具维护正在进行，等待维护完成后继续当前操作…\n' >&2
        flock -s "$PC_OPERATION_FD"
    fi
}
pc_operation_unlock() {
    if [[ -n "${PC_OPERATION_FD:-}" ]]; then exec {PC_OPERATION_FD}>&-; PC_OPERATION_FD=; fi
}
pc_maintenance_lock() {
    local mask
    mask=$(umask)
    umask 077
    exec {PC_MAINTENANCE_FD}>>"$REPO/.update.lock"
    exec {PC_SERVICES_FD}>>"$REPO/.services.lock"
    umask "$mask"
    printf '等待其他构建／维护完成…\n'; flock -x "$PC_MAINTENANCE_FD"
    flock -x "$PC_SERVICES_FD"
}
pc_managed_services() {
    docker ps -aq --filter "label=com.docker.compose.project.working_dir=$REPO" \
        --filter label=com.docker.compose.service=services --filter "label=com.docker.compose.project=app-services-r${REPO_HASH}"
}
pc_managed_terminals() {
    docker ps -aq --filter "label=io.pi-container.installation=$REPO_HASH" \
        --filter "label=io.pi-container.user=$UID_VALUE" --filter label=io.pi-container.role=service-terminal
}
pc_update_mount() {
    docker inspect --format "{{range .Mounts}}{{if eq .Destination \"$2\"}}{{.Source}}{{end}}{{end}}" "$1"
}
pc_show_activity() {
    local cid=$1 project_name=$2 state=$3 summary=${4:-false} rows name attached _created fd lease ids
    [[ "$summary" == true ]] || printf '  状态：%s\n' "${state:-未知}"
    if [[ "$state" == running ]]; then
        if rows=$(docker exec --user "$PIC_UID:$PIC_GID" "$cid" /usr/local/bin/pic-session list); then
            if [[ -z "$rows" && "$summary" != true ]]; then printf '  托管 Pi：无\n'; fi
            while IFS=$'\t' read -r name attached _created; do
                [[ -n "$name" ]] || continue
                printf '  Pi 会话：%s · 终端连接：%s\n' "$name" "${attached:-未知}"
            done <<< "$rows"
        else printf '  Pi 会话：无法读取，状态未知；确认继续仍会中断。\n'; fi
        ids=$(docker inspect --format '{{range .ExecIDs}}{{println .}}{{end}}' "$cid") || ids=未知
        if [[ -n "$ids" || "$summary" != true ]]; then printf '  Docker exec／终端连接：\n%s\n' "${ids:-无}"; fi
    elif [[ "$state" != exited && "$state" != created ]]; then
        printf '  会话状态无法确认；确认继续仍会中断，重建后不启动。\n'
    fi
    for lease in "$REPO/.runtime/$project_name"/session.*; do
        [[ -f "$lease" ]] || continue
        if exec {fd}<"$lease"; then
            if ! flock -n -x "$fd"; then printf '  宿主终端连接：%s\n' "${lease##*/}"; fi
            exec {fd}>&-
        else printf '  宿主终端连接：状态未知\n'; fi
    done
}
pc_current_activity() {
    local cid state
    # CURRENT is supplied by the private dispatcher.
    # shellcheck disable=SC2153
    cid=$("${CURRENT[@]}" ps -aq pi) || return
    [[ -n "$cid" ]] || { printf '当前项目暂无开发容器。\n'; return 0; }
    state=$(docker inspect --format '{{.State.Status}}' "$cid") || state=未知
    printf '项目：%s\n' "$WORKDIR"
    pc_show_activity "$cid" "$PROJECT" "$state"
    printf '这是当前快照；确认操作会中断此容器内的全部会话与连接，保留挂载数据。\n'
}
pc_update_inventory() {
    local strict=${1:-strict} projects name cid directory state credentials data services terminals current_project=$PROJECT current_included=false
    UPDATE_PROJECTS=(); UPDATE_IDS=(); UPDATE_DIRECTORIES=(); UPDATE_CREDENTIALS=(); UPDATE_SERVICES=(); UPDATE_SERVICE_STATES=(); UPDATE_TERMINALS=()
    if [[ "$strict" == strict ]]; then
        ENV_FILE="$REPO/.env"; [[ -f "$ENV_FILE" ]] || ENV_FILE="$REPO/.env.example"
        COMPOSE=(docker compose --project-directory "$REPO" --project-name "$PROJECT" --file "$REPO/compose.yaml" --env-file "$ENV_FILE")
        deployment_config || return
    fi
    projects=$(managed_projects | sort -u) || return
    while IFS= read -r name; do
        [[ -n "$name" ]] || continue
        cid=$("${CORE[@]}" --project-name "$name" ps -aq pi) || return
        [[ -n "$cid" && "$cid" != *$'\n'* ]] || { printf '开发容器列表已变化，请重新检查。\n' >&2; return 1; }
        directory=$(pc_update_mount "$cid" /workspace) || return
        credentials=
        if [[ "$strict" == strict ]]; then
            data=$(pc_update_mount "$cid" /home/node/.pi/agent) || return
            if [[ "$directory" != /* || "$directory" =~ [[:cntrl:]] || ! -d "$directory" || "$data" != "$REPO/data" ]]; then
                printf '项目或 Pi 数据挂载与本安装不一致，请核对后重新检查。\n' >&2; return 1
            fi
            # WORKDIR is consumed by deployment_require_workspace in another library.
            # shellcheck disable=SC2034
            WORKDIR=$directory; deployment_require_workspace || return
            credentials=$(pc_update_mount "$cid" /run/deploy-credentials) || return
            if [[ -n "$credentials" && ( "$credentials" != "$REPO/.deploy-keys/installation" || ! -d "$credentials" ) ]]; then
                printf '部署凭据挂载与配置不一致，请核对后重新检查。\n' >&2; return 1
            fi
        fi
        state=$(docker inspect --format '{{.State.Status}}' "$cid") || state=未知
        UPDATE_PROJECTS+=("$name"); UPDATE_IDS+=("$cid"); UPDATE_DIRECTORIES+=("$directory"); UPDATE_CREDENTIALS+=("$credentials")
        if [[ "$name" == "$current_project" ]]; then current_included=true; fi
        if [[ "$strict" == dev ]]; then
            printf '开发项目：%s\n' "${directory:-挂载未知}"
            pc_show_activity "$cid" "$name" "$state"
        else pc_show_activity "$cid" "$name" "$state" true; fi
    done <<< "$projects"
    if [[ "$strict" == dev ]]; then services=; else services=$(pc_managed_services) || return; fi
    while IFS= read -r cid; do
        [[ -n "$cid" ]] || continue
        if [[ "$strict" == strict ]]; then
            deployment_require_config || return
            data=$(pc_update_mount "$cid" /srv/app-services) || return
            [[ -d "$DEPLOY_DATA_DIR" && "$data" == "$DEPLOY_DATA_DIR" ]] || { printf '服务数据挂载与 DEPLOY_DATA_DIR 不一致，请核对后重新检查；不会切换数据目录。\n' >&2; return 1; }
        fi
        state=$(docker inspect --format '{{.State.Status}}' "$cid") || state=未知
        UPDATE_SERVICES+=("$cid"); UPDATE_SERVICE_STATES+=("$state")
        if [[ "$state" == running ]]; then
            printf '服务应用（重建／卸载会中断）：\n'
            docker exec --user 0 "$cid" supervisorctl -c /opt/app-services/supervisord.conf status || printf '应用及 SSH 状态未知；确认后仍会中断。\n'
            terminals=$(docker inspect --format '{{range .ExecIDs}}{{println .}}{{end}}' "$cid") || terminals=未知
            [[ -z "$terminals" ]] || printf '  服务 exec／终端连接：\n%s\n' "$terminals"
        elif [[ "$state" != exited && "$state" != created ]]; then printf '服务会话状态未知；确认后仍会中断全部连接。\n'; fi
    done <<< "$services"
    if [[ "$strict" == strict && ${#UPDATE_SERVICES[@]} -gt 1 ]]; then printf '发现多个共享服务容器，请核对后重新检查。\n' >&2; return 1; fi
    if [[ "$strict" != dev ]]; then
        terminals=$(pc_managed_terminals) || return
        while IFS= read -r cid; do
            [[ -n "$cid" ]] || continue
            UPDATE_TERMINALS+=("$cid")
            printf '服务管理终端：%s；确认后中断 SSH／Shell 连接，不重新创建此临时终端。\n' "$cid"
        done <<< "$terminals"
    fi
    printf '\n范围：本安装、当前用户的 %s 个开发容器，%s 个共享服务，%s 个管理终端。\n' "${#UPDATE_IDS[@]}" "${#UPDATE_SERVICES[@]}" "${#UPDATE_TERMINALS[@]}"
    if [[ "$current_included" == true ]]; then printf '包含当前项目的开发容器。\n'; fi
    printf '确认会中断范围内全部会话与连接，包括后台 Pi、新连接及状态未知的连接。清单为当前快照。\n'
    printf '保留配置、历史、身份、应用数据和部署脚本；容器可写层丢失，请先备份。\n'
}
pc_resource_state() {
    local projects services terminals images
    projects=$(managed_projects) || return
    services=$(pc_managed_services) || return
    terminals=$(pc_managed_terminals) || return
    images=$(docker image ls -q --filter dangling=true --filter "label=io.pi-container.installation=$REPO_HASH") || return
    if [[ -n "$projects$services$terminals$images" ]] || docker image inspect "$PIC_IMAGE" >/dev/null 2>&1 || docker image inspect "app-services:r$REPO_HASH" >/dev/null 2>&1; then printf present
    else printf empty; fi
}
pc_service_activity() {
    local services cid
    services=$(pc_managed_services) || return
    [[ -n "$services" ]] || { printf '暂无共享服务容器。\n'; return 0; }
    while IFS= read -r cid; do
        printf '共享服务容器：%s；应用、SSH 及其他连接会中断。\n' "$cid"
        docker exec --user 0 "$cid" supervisorctl -c /opt/app-services/supervisord.conf status || printf '应用及 SSH 状态无法完整读取；确认继续仍会中断。\n'
    done <<< "$services"
}
pc_build_image() {
    local kind=$1
    if [[ "$kind" == development ]]; then
        printf '\n无缓存构建开发镜像…\n'
        docker build --pull --no-cache --label "io.pi-container.installation=$REPO_HASH" --tag "$PIC_IMAGE" "$REPO"
    else
        printf '\n无缓存构建服务镜像…\n'
        docker build --pull --no-cache --label "io.pi-container.installation=$REPO_HASH" --file "$REPO/services/Dockerfile" --tag "app-services:r$REPO_HASH" "$REPO"
    fi
}
pc_require_image() (
    # First use builds only the missing image, never its unrelated counterpart.
    # Serialize first-use builds across projects without holding a terminal lease.
    set -euo pipefail
    local kind=$1 image=$PIC_IMAGE build_fd
    [[ "$kind" != service ]] || image="app-services:r$REPO_HASH"
    if docker image inspect "$image" >/dev/null 2>&1; then exit 0; fi
    umask 077
    mkdir -p -- "$REPO/.runtime/images"
    exec {build_fd}>>"$REPO/.runtime/images/$kind.lock"
    flock -x "$build_fd"
    if ! docker image inspect "$image" >/dev/null 2>&1; then pc_build_image "$kind" >&2; fi
)
pc_build_images() {
    pc_build_image development || return
    pc_build_image service
}
pc_uninstall() (
    set -euo pipefail
    local image tagged candidates cid name status=0 tag tags network networks
    local -a ids
    pc_maintenance_lock
    pc_update_inventory loose
    candidates=$(docker image ls -q --filter "label=io.pi-container.installation=$REPO_HASH")
    for cid in "${UPDATE_IDS[@]}" "${UPDATE_SERVICES[@]}" "${UPDATE_TERMINALS[@]}"; do
        image=$(docker inspect --format '{{.Image}}' "$cid")
        candidates+=$'\n'"$image"
    done
    for image in "$PIC_IMAGE" "app-services:r$REPO_HASH"; do
        tagged=$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null) || tagged=
        [[ -z "$tagged" ]] || candidates+=$'\n'"$tagged"
    done
    # No --volumes, no data-directory deletion, no global prune and no force rmi.
    ids=("${UPDATE_IDS[@]}" "${UPDATE_SERVICES[@]}" "${UPDATE_TERMINALS[@]}")
    if (( ${#ids[@]} )); then
        for cid in "${ids[@]}"; do
            image=$(docker inspect --format '{{.State.Status}}' "$cid") || image=unknown
            [[ "$image" != paused ]] || docker unpause "$cid"
        done
        docker stop --time 30 "${ids[@]}"
        docker rm --force "${ids[@]}"
    fi
    for name in "${UPDATE_PROJECTS[@]}" "app-services-r$REPO_HASH"; do
        networks=$(docker network ls -q --filter "label=com.docker.compose.project=$name")
        for network in $networks; do docker network rm "$network" || status=$?; done
    done
    for image in "$PIC_IMAGE" "app-services:r$REPO_HASH"; do
        if docker image inspect "$image" >/dev/null 2>&1; then docker image rm "$image" || status=$?; fi
    done
    candidates=$(printf '%s\n' "$candidates" | sort -u)
    while IFS= read -r image; do
        [[ -n "$image" ]] || continue
        if tags=$(docker image inspect --format '{{range .RepoTags}}{{println .}}{{end}}' "$image" 2>/dev/null); then
            tag=; while IFS= read -r tagged; do [[ -z "$tagged" || "$tagged" == '<none>:<none>' ]] || tag=$tagged; done <<< "$tags"
            if [[ -n "$tag" ]]; then printf '镜像还有其他标签，保留共享镜像：%s\n' "$image"
            else docker image rm "$image" || status=$?; fi
        fi
    done <<< "$candidates"
    (( status == 0 )) || return "$status"
    printf '\n「卸载完成」本安装范围的容器、镜像及可删除网络已移除；共享引用的镜像不强删。\n'
    printf '已保留源码、pc 入口、配置、会话／历史、应用数据和部署脚本；下次使用对应功能时按需准备环境。\n'
)
pc_update_protected() {
    case "$1" in
        .env.example) return 1 ;;
        .env|.env.*|data|data/*|services-data|services-data/*|.runtime|.runtime/*|.deploy-keys|.deploy-keys/*|.services.lock|.update.lock|workspace|workspace/*|node_modules|node_modules/*|.gitmodules|\"*) return 0 ;;
        *) return 1 ;;
    esac
}
pc_update_tree() {
    local tree path
    tree=$(pc_update_git ls-tree -r --name-only "$1") || return
    while IFS= read -r path; do
        if pc_update_protected "$path"; then
            printf '源码包含受保护的本地数据路径或不支持的路径，请核对版本后重新检查；不会覆盖配置或持久数据。\n' >&2; return 1
        fi
    done <<< "$tree"
}
pc_update_backup() {
    local old=$1 target=$2 temp=$3 name path main
    name="pc-backup-$(date -u +%Y%m%dT%H%M%SZ)-$$"
    pc_update_git update-ref "refs/heads/$name" "$old"
    main=$(pc_update_git rev-parse --verify refs/heads/main 2>/dev/null) || main=
    if [[ -n "$main" && "$main" != "$old" ]]; then pc_update_git update-ref "refs/heads/${name}-main" "$main"; fi
    pc_update_git ls-files --cached --others --exclude-standard -z > "$temp/files"
    while IFS= read -r -d '' path; do
        pc_update_protected "$path" || printf '%s\0' "$path" >> "$temp/paths"
    done < "$temp/files"
    if [[ -s "$temp/paths" ]]; then pc_update_git stash push --include-untracked --message "$name" --pathspec-from-file="$temp/paths" --pathspec-file-nul; fi
    printf '本地提交备份：%s；文件修改保留在本地 Git stash，不自动重放。\n' "$name"
    pc_update_git switch --no-overwrite-ignore -C main "$target"
}
pc_update_apply() (
    set -euo pipefail
    local old=$1 target=$2 mode=$3 current temp i name
    local PIC_WORKSPACE=$PIC_WORKSPACE PIC_HISTORY_DIR=$PIC_HISTORY_DIR DEPLOY_CREDENTIAL_DIR=${DEPLOY_CREDENTIAL_DIR:-}
    temp=$(umask 077; mktemp -d)
    trap 'status=$?; rm -rf -- "$temp"; if (( status )); then printf "维护未完成；已更新的源码、镜像或容器不会自动回滚。返回菜单后可选择「检查更新」，重新核对并确认后重试。\\n" >&2; fi' EXIT
    pc_maintenance_lock
    pc_update_repository
    current=$(pc_update_git rev-parse HEAD)
    [[ "$current" == "$old" && "$(pc_update_git rev-parse 'refs/pi-container/update^{commit}')" == "$target" ]] || { printf '版本已在确认期间变化，请重新检查并确认。\n' >&2; exit 1; }
    if [[ "$mode" != backup && "$(pc_update_local_mode "$target")" != standard ]]; then printf '本地源码已变化，请重新检查并选择是否备份后更新。\n' >&2; exit 1; fi
    pc_update_tree HEAD; pc_update_tree "$target"
    pc_update_inventory
    printf '\n更新宿主源码：%.8s → %.8s\n' "$old" "$target"
    if [[ "$mode" == backup ]]; then pc_update_backup "$old" "$target" "$temp"
    else pc_update_git merge --ff-only --no-edit --no-overwrite-ignore "$target"; fi
    pc_build_images
    if (( ${#UPDATE_TERMINALS[@]} )); then docker rm --force "${UPDATE_TERMINALS[@]}"; fi
    if (( ${#UPDATE_SERVICES[@]} )); then
        printf '\n重建共享服务容器…\n'
        if [[ "${UPDATE_SERVICE_STATES[0]}" == running ]]; then "${SERVICE_COMPOSE[@]}" up -d --wait --force-recreate --no-build --no-deps services
        else
            [[ "${UPDATE_SERVICE_STATES[0]}" != paused ]] || docker unpause "${UPDATE_SERVICES[0]}"
            "${SERVICE_COMPOSE[@]}" up --no-start --force-recreate --no-build --no-deps services
        fi
    fi
    for ((i=0; i<${#UPDATE_PROJECTS[@]}; i++)); do
        name=${UPDATE_PROJECTS[i]}
        export PIC_WORKSPACE=${UPDATE_DIRECTORIES[i]} PIC_HISTORY_DIR="/home/node/.pi/agent/project-history/${UID_VALUE}-${name##*-}"
        COMPOSE=(docker compose --project-directory "$REPO" --project-name "$name" --file "$REPO/compose.yaml" --env-file "$ENV_FILE")
        if [[ -n "${UPDATE_CREDENTIALS[i]}" && -n "$DEPLOY_DATA_DIR" ]]; then export DEPLOY_CREDENTIAL_DIR=${UPDATE_CREDENTIALS[i]}; COMPOSE+=(--file "$REPO/compose.deploy.yaml"); fi
        printf '\n重建开发容器（%s/%s）…\n' "$((i + 1))" "${#UPDATE_PROJECTS[@]}"
        current=$(docker inspect --format '{{.State.Status}}' "${UPDATE_IDS[i]}") || current=未知
        [[ "$current" != paused ]] || docker unpause "${UPDATE_IDS[i]}"
        "${COMPOSE[@]}" up --no-start --force-recreate --no-build --no-deps pi
    done
    printf '\n「更新完成」源码、全部受管镜像与已有容器已更新。\n'
    printf 'Pi 不会被自动重启或重发请求；开发容器保持停止，下次使用时启动。服务原先停止的仍不启动。\n'
    printf '未更新持久化 Gateway 插件，未创建原本不存在的容器；返回主菜单时重新加载宿主代码。\n'
)
