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
    SERVICE_COMPOSE=(docker compose --project-directory "$REPO" --project-name "app-services-r${REPO_HASH}"
        --file "$REPO/compose.services.yaml" --env-file "$ENV_FILE")
}

deployment_require_workspace() {
    local protected
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
        printf '先设置 DEPLOY_DATA_DIR，例如 ./services-data（相对安装目录）。\n' >&2
        return 1
    fi
    if [[ "$DEPLOY_DATA_DIR" == / || "$DEPLOY_DATA_DIR" == "$REPO" || "$REPO" == "$DEPLOY_DATA_DIR/"* ||
          ( "$DEPLOY_DATA_DIR" == "$REPO/"* && "$DEPLOY_DATA_DIR" != "$REPO/services-data" ) ]]; then
        printf '安装目录内仅允许 ./services-data；也可使用独立的外部目录。\n' >&2
        return 1
    fi
    if [[ ! "$DEPLOY_PORT" =~ ^[0-9]{4,5}$ ]] || (( 10#$DEPLOY_PORT < 1024 || 10#$DEPLOY_PORT > 65535 )); then
        printf 'DEPLOY_PORT 须为 1024–65535。\n' >&2
        return 1
    fi
}

deployment_prepare_data() {
    # Explicit host-side creation only for start/recreate, never status or app policy reads.
    # Compose must not silently create a root-owned bind source.
    (umask 077; mkdir -p -- "$DEPLOY_DATA_DIR") || return
    [[ -d "$DEPLOY_DATA_DIR" ]] || return 1
}

provision_deployment() {
    local credentials host_key
    deployment_require_config || return
    deployment_prepare_data || return
    umask 077
    credentials="$REPO/.deploy-keys/installation"
    mkdir -p -- "$credentials"
    exec {deploy_fd}>>"$credentials/provision.lock"
    flock -x "$deploy_fd"
    if [[ ! -f "$credentials/id_ed25519" ]]; then
        ssh-keygen -q -t ed25519 -N '' -f "$credentials/id_ed25519"
    fi
    # A checkout-wide lock also serializes up/register with explicit service
    # maintenance from another project. Release it before any long Pi session.
    exec {service_fd}>>"$REPO/.services.lock"
    flock -x "$service_fd"
    "${SERVICE_COMPOSE[@]}" up -d --wait --no-recreate --no-build services >&2
    host_key=$("${SERVICE_COMPOSE[@]}" exec -T services /usr/local/bin/deploy-register \
        "$(<"$credentials/id_ed25519.pub")")
    if [[ ! "$host_key" =~ ^ssh-ed25519\ [A-Za-z0-9+/]+={0,2}$ ]]; then
        printf '服务 SSH 主机密钥不合法，未更新信任记录。\n' >&2
        return 1
    fi
    # Atomic replacement prevents concurrent SSH clients reading a partial key.
    # Base64-shaped text is not necessarily a valid SSH public-key structure.
    printf '[app-services]:2222 %s\n' "$host_key" > "$credentials/known_hosts.tmp"
    if ! ssh-keygen -l -f "$credentials/known_hosts.tmp" >/dev/null 2>&1; then
        rm -f -- "$credentials/known_hosts.tmp"
        printf '服务 SSH 主机密钥不合法，未更新信任记录。\n' >&2
        return 1
    fi
    mv -- "$credentials/known_hosts.tmp" "$credentials/known_hosts"
    flock -u "$service_fd"
    exec {service_fd}>&-
    flock -u "$deploy_fd"
    exec {deploy_fd}>&-
    export DEPLOY_CREDENTIAL_DIR="$credentials"
    COMPOSE+=(--file "$REPO/compose.deploy.yaml")
}
