#!/usr/bin/env bash
# Edit only the three deployment settings in the existing dotenv file. Compose
# remains the parser; no host Node/Python, shell evaluation or second registry.
# Each operation initializes its own state; ShellCheck is not call-order aware.
# shellcheck disable=SC2030,SC2031
deployment_settings_snapshot() {
    local file=$1 metadata size links owner
    SETTINGS_CONTENT=''; SETTINGS_REVISION=missing
    [[ -e "$file" || -L "$file" ]] || return 0
    if [[ -L "$file" || ! -f "$file" ]]; then
        printf '部署配置须为普通文件，不能是符号链接；未修改。\n' >&2; return 1
    fi
    metadata=$(stat -c '%s %h %u' -- "$file") || return
    read -r size links owner <<< "$metadata"
    if (( size > 1048576 || links != 1 || owner != EUID )); then
        printf '部署配置须由当前用户所有、单硬链接且不超过 1 MiB；未修改。\n' >&2; return 1
    fi
    # O_NOFOLLOW/nonblocking and a bounded read avoid following a raced symlink
    # or waiting on a replaced FIFO. NUL input is never silently rewritten.
    dd if="$file" of="$SETTINGS_SNAPSHOT" iflag=nofollow,nonblock bs=65536 count=17 status=none || return
    if (( $(stat -c %s -- "$SETTINGS_SNAPSHOT") > 1048576 )); then return 1; fi
    if IFS= read -r -d '' SETTINGS_CONTENT < "$SETTINGS_SNAPSHOT"; then
        printf '部署配置含 NUL 字节；未修改。\n' >&2; return 1
    fi
    SETTINGS_REVISION=$(sha256sum -- "$SETTINGS_SNAPSHOT"); SETTINGS_REVISION=${SETTINGS_REVISION%% *}
}
deployment_settings_parse() {
    local file=$1 config line
    config=$(env -u DEPLOY_DATA_DIR -u DEPLOY_PORT -u DEPLOY_PUBLIC_URL \
        "${CORE[@]:0:${#CORE[@]}-2}" --env-file "$file" config --environment) || return
    SETTINGS_DATA=''; SETTINGS_PORT=18080; SETTINGS_URL=''
    while IFS= read -r line; do
        case "$line" in
            DEPLOY_DATA_DIR=*) SETTINGS_DATA=${line#*=} ;;
            DEPLOY_PORT=*) SETTINGS_PORT=${line#*=} ;;
            DEPLOY_PUBLIC_URL=*) SETTINGS_URL=${line#*=} ;;
        esac
    done <<< "$config"
}
deployment_settings_get() (
    set -euo pipefail
    local SETTINGS_SNAPSHOT SETTINGS_CONTENT SETTINGS_REVISION SETTINGS_DATA SETTINGS_PORT SETTINGS_URL value
    SETTINGS_SNAPSHOT=$(umask 077; mktemp)
    trap 'rm -f -- "$SETTINGS_SNAPSHOT"' EXIT
    deployment_settings_snapshot "$REPO/.env"
    if [[ "$SETTINGS_REVISION" == missing ]]; then cp -- "$REPO/.env.example" "$SETTINGS_SNAPSHOT"; fi
    deployment_settings_parse "$SETTINGS_SNAPSHOT"
    for value in "$SETTINGS_DATA" "$SETTINGS_PORT" "$SETTINGS_URL"; do
        if [[ "$value" == *[[:cntrl:]]* ]]; then printf '部署配置含多行或控制字符，请在外部编辑后重新打开。\n' >&2; exit 1; fi
    done
    printf '%s\n%s\n%s\n%s\n' "$SETTINGS_REVISION" "$SETTINGS_DATA" "$SETTINGS_PORT" "$SETTINGS_URL"
)
deployment_settings_save() (
    set -euo pipefail
    local expected=$1 directory=$2 port=$3 url=$4 SETTINGS_SNAPSHOT SETTINGS_CONTENT SETTINGS_REVISION SETTINGS_DATA SETTINGS_PORT SETTINGS_URL
    local candidate='' service_fd line parsed tail key eol body='' newline=$'\n' value quote i escaped check_revision name authority
    for value in "$directory" "$port" "$url"; do
        if [[ "$value" == *[[:cntrl:]]* ]] || (( ${#value} > 8192 )); then printf '部署配置仅接受不超过 8192 字符的单行值；未修改。\n' >&2; exit 1; fi
    done
    DEPLOY_DATA_DIR=$directory
    # deployment_require_config reads the candidate port without exporting it.
    # shellcheck disable=SC2034
    DEPLOY_PORT=$port
    if [[ -n "$directory" ]]; then
        [[ "$directory" == /* ]] || DEPLOY_DATA_DIR="$REPO/$directory"
        DEPLOY_DATA_DIR=$(realpath -m -- "$DEPLOY_DATA_DIR")
        deployment_require_config
    elif [[ ! "$port" =~ ^[0-9]{4,5}$ ]] || (( 10#$port < 1024 || 10#$port > 65535 )); then
        printf 'DEPLOY_PORT 须为 1024–65535；未修改。\n' >&2; exit 1
    fi
    if [[ -n "$url" ]]; then
        authority=${url#*://}; authority=${authority%%[/?#]*}
        if [[ ! "$url" =~ ^https?:// || -z "$authority" || "$authority" == *@* || "$url" == *[[:space:]]* ]]; then
            printf '公网模板须为空或不含凭据、空白的 HTTP(S) 地址；未修改。\n' >&2; exit 1
        fi
    fi
    pc_operation_lock
    exec {service_fd}>>"$REPO/.services.lock"; flock -x "$service_fd"
    SETTINGS_SNAPSHOT=$(umask 077; mktemp)
    trap 'rm -f -- "$SETTINGS_SNAPSHOT"; [[ -z "$candidate" ]] || rm -f -- "$candidate"' EXIT
    deployment_settings_snapshot "$REPO/.env"
    [[ "$SETTINGS_REVISION" == "$expected" ]] || { printf '.env 已被其他操作者修改，请重新打开「部署配置」；未覆盖。\n' >&2; exit 1; }
    # Reject multiline/nonstandard dotenv rather than accidentally editing an
    # assignment-shaped line inside another value. Unrelated bytes stay intact.
    [[ "$SETTINGS_CONTENT" != *$'\r\n'* ]] || newline=$'\r\n'
    while [[ -n "$SETTINGS_CONTENT" ]]; do
        if [[ "$SETTINGS_CONTENT" == *$'\n'* ]]; then line=${SETTINGS_CONTENT%%$'\n'*}; SETTINGS_CONTENT=${SETTINGS_CONTENT#*$'\n'}; eol=$'\n'
        else line=$SETTINGS_CONTENT; SETTINGS_CONTENT=''; eol=''; fi
        parsed=${line%$'\r'}
        if [[ "$parsed" =~ ^[[:blank:]]*(#.*)?$ ]]; then body+="$line$eol"; continue; fi
        if [[ ! "$parsed" =~ ^[[:blank:]]*(export[[:blank:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:blank:]]*=[[:blank:]]*(.*)$ ]]; then
            printf '.env 含多行或非标准定义，请在外部编辑；未修改。\n' >&2; exit 1
        fi
        key=${BASH_REMATCH[2]}; tail=${BASH_REMATCH[3]}; quote=${tail:0:1}
        if [[ "$quote" == "'" || "$quote" == '"' ]]; then
            escaped=0
            for ((i=1; i<${#tail}; i++)); do
                value=${tail:i:1}
                if [[ "$value" == "$quote" && "$escaped" == 0 ]]; then break; fi
                if [[ "$value" == \\ && "$escaped" == 0 ]]; then escaped=1; else escaped=0; fi
            done
            if (( i == ${#tail} )) || [[ ! "${tail:i+1}" =~ ^[[:blank:]]*(#.*)?$ ]]; then
                printf '.env 含多行或非标准引号，请在外部编辑；未修改。\n' >&2; exit 1
            fi
        fi
        case "$key" in DEPLOY_DATA_DIR|DEPLOY_PORT|DEPLOY_PUBLIC_URL) ;; *) body+="$line$eol" ;; esac
    done
    [[ -z "$body" || "$body" == *$'\n' ]] || body+=$newline
    for key in DEPLOY_DATA_DIR DEPLOY_PORT DEPLOY_PUBLIC_URL; do
        case "$key" in DEPLOY_DATA_DIR) value=$directory ;; DEPLOY_PORT) value=$port ;; *) value=$url ;; esac
        value=${value//\'/\\\'}
        body+="$key='$value'$newline"
    done
    candidate=$(umask 077; mktemp "$REPO/.env.pc-XXXXXXXX")
    printf '%s' "$body" > "$candidate"
    deployment_settings_parse "$candidate"
    if [[ "$SETTINGS_DATA" != "$directory" || "$SETTINGS_PORT" != "$port" || "$SETTINGS_URL" != "$url" ]]; then
        printf 'Compose 未能按原值解析配置；未修改。请使用标准单行值。\n' >&2; exit 1
    fi
    check_revision=$SETTINGS_REVISION
    deployment_settings_snapshot "$REPO/.env"
    [[ "$SETTINGS_REVISION" == "$check_revision" ]] || { printf '.env 已被其他操作者修改，请重新打开「部署配置」；未覆盖。\n' >&2; exit 1; }
    mv -T -- "$candidate" "$REPO/.env"; candidate=''
    printf '「部署配置已保存」仅修改 .env；未构建、启动、停止或替换容器，也未搬移／删除数据。\n'
    printf '已有容器继续使用原端口和挂载；若有效配置需要应用，菜单将另行列出差异并询问是否重建服务容器。取消重建不撤销已保存的配置。\n'
    printf '原先未接入部署的开发容器不会被自动重建；如需接入，请结束相关 Pi／终端，明确删除该开发容器，再次启动以连接已运行的服务。\n'
    for name in DEPLOY_DATA_DIR DEPLOY_PORT DEPLOY_PUBLIC_URL; do
        if printenv "$name" >/dev/null; then printf '注意：宿主环境变量 %s 优先于 .env；需取消该覆盖后新配置才生效。\n' "$name"; fi
    done
)

# A review is bound to the effective configuration and the exact existing
# container/state. No marker or second settings registry is persisted.
deployment_recreate_snapshot() {
    local before after
    RECREATE_TOKEN=none; RECREATE_ID=''; RECREATE_STATE=''; RECREATE_DATA=''; RECREATE_BINDING=''
    ENV_FILE="$REPO/.env"; [[ -f "$ENV_FILE" ]] || ENV_FILE="$REPO/.env.example"
    before=$(sha256sum -- "$ENV_FILE" "$REPO/compose.yaml" "$REPO/compose.services.yaml") || return "$?"
    # Used by deployment_config in the deployment library.
    # shellcheck disable=SC2034
    COMPOSE=(docker compose --project-directory "$REPO" --project-name "$PROJECT" --file "$REPO/compose.yaml" --env-file "$ENV_FILE")
    deployment_config || return "$?"
    [[ -n "$DEPLOY_DATA_DIR" ]] || return 0
    deployment_require_config || return "$?"
    RECREATE_ID=$(deployment_existing_container) || return "$?"
    [[ -n "$RECREATE_ID" ]] || return 0
    RECREATE_DATA=$(pc_update_mount "$RECREATE_ID" /srv/app-services) || return "$?"
    RECREATE_BINDING=$(deployment_port_binding "$RECREATE_ID") || return "$?"
    if [[ "$RECREATE_DATA" != /* || "$RECREATE_DATA" == *[[:cntrl:]]* ]]; then
        printf '无法核对现有服务的持久数据挂载；未重建，请检查后重试。\n' >&2; return 1
    fi
    [[ "$RECREATE_DATA" != "$DEPLOY_DATA_DIR" || "$RECREATE_BINDING" != "127.0.0.1:$DEPLOY_PORT" ]] || return 0
    RECREATE_STATE=$(docker inspect --format '{{.State.Status}}' "$RECREATE_ID") || RECREATE_STATE=unknown
    after=$(sha256sum -- "$ENV_FILE" "$REPO/compose.yaml" "$REPO/compose.services.yaml") || return "$?"
    [[ "$before" == "$after" ]] || { printf '部署配置在读取期间变化，请重新检查。\n' >&2; return 1; }
    RECREATE_TOKEN=$(printf '%s\0' "$before" "$RECREATE_ID" "$RECREATE_STATE" "$RECREATE_DATA" "$RECREATE_BINDING" \
        "$DEPLOY_DATA_DIR" "$DEPLOY_PORT" "$DEPLOY_PUBLIC_URL" | sha256sum) || return "$?"
    RECREATE_TOKEN=${RECREATE_TOKEN%% *}
}
deployment_recreate_plan() (
    set -euo pipefail
    local RECREATE_TOKEN RECREATE_ID RECREATE_STATE RECREATE_DATA RECREATE_BINDING
    deployment_recreate_snapshot
    printf '%s\n' "$RECREATE_TOKEN"
    [[ "$RECREATE_TOKEN" != none ]] || exit 0
    printf '「部署配置待应用」仅重建本安装的共享服务容器。\n数据目录：%s → %s\nHTTP 端口：%s → 127.0.0.1:%s\n' \
        "$RECREATE_DATA" "$DEPLOY_DATA_DIR" "${RECREATE_BINDING:-未绑定}" "$DEPLOY_PORT"
    if [[ "$RECREATE_DATA" != "$DEPLOY_DATA_DIR" ]]; then
        printf '「数据目录改变」旧目录与数据保留，不自动迁移到新目录；新目录缺少部署脚本／应用数据时，不会恢复旧应用。请先备份并确认目标目录已准备好。\n'
    fi
    if [[ "$RECREATE_STATE" == running ]]; then printf '重建后恢复运行，执行持久化部署脚本并等待核心健康；仍需验收各应用。\n'
    else printf '原先停止或状态未知：重建后保持停止，不执行脚本或启动应用；仅明确选择「启动容器」才启动。\n'; fi
    printf '应用和全部 SSH／终端连接会中断，可写层及管理 HOME 会丢失；挂载数据和部署脚本保留。请先备份。\n'
    printf '复用已有服务镜像；仅缺少时才构建。不重建开发容器、不重启 Pi，也不重发部署请求。\n'
    deployment_show_activity "$RECREATE_ID" "$RECREATE_STATE"
)
deployment_recreate_apply() (
    set -euo pipefail
    local expected=$1 service_fd RECREATE_TOKEN RECREATE_ID RECREATE_STATE RECREATE_DATA RECREATE_BINDING
    pc_operation_lock
    exec {service_fd}>>"$REPO/.services.lock"; flock -x "$service_fd"
    deployment_recreate_snapshot
    [[ "$RECREATE_TOKEN" == "$expected" ]] || { printf '配置、容器或运行状态已在确认期间变化，请重新检查并确认；未重建。\n' >&2; exit 1; }
    trap 'status=$?; if (( status )); then printf "重建未完成；已保存的配置和已完成步骤保留，不自动回滚。请通过「部署配置」或「启动容器」重新检查并确认后重试。\n" >&2; fi' EXIT
    # All fallible preparation precedes container interruption. Recheck after a
    # potentially slow first-use build; external Docker/admins may ignore locks.
    pc_require_image service
    deployment_recreate_snapshot
    [[ "$RECREATE_TOKEN" == "$expected" ]] || { printf '配置、容器或运行状态已在准备期间变化，请重新检查并确认；未替换容器。\n' >&2; exit 1; }
    deployment_prepare_data
    if [[ "$RECREATE_STATE" == running ]]; then
        "${SERVICE_COMPOSE[@]}" up -d --wait --force-recreate --no-build --no-deps --pull never services
        printf '「服务容器已重建」已恢复核心服务；请验收部署脚本和各应用健康。\n'
    else
        [[ "$RECREATE_STATE" != paused ]] || docker unpause "$RECREATE_ID"
        "${SERVICE_COMPOSE[@]}" up --no-start --force-recreate --no-build --no-deps --pull never services
        printf '「服务容器已重建」保持停止，下次明确启动时执行部署脚本。\n'
    fi
    printf '未迁移或删除旧目录数据，未重建开发容器、重启 Pi 或重发请求。\n'
)
