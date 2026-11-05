#!/usr/bin/env bash
# Shared only by smoke checks and their isolated regression tests.
smoke_container_diagnostics() {
    local container=$1
    printf '\n--- Container diagnostics: %s ---\n' "$container" >&2
    docker inspect --format 'status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{json .State.Error}}' \
        "$container" >&2 || return 0
    docker logs --tail 150 "$container" >&2 || true
}

smoke_wait_service() {
    local container=$1 attempts=${2:-60} interval=${3:-1} state attempt
    for (( attempt=1; attempt<=attempts; attempt++ )); do
        if ! state=$(docker inspect --format '{{.State.Status}}' "$container"); then
            printf '无法读取服务容器状态：%s\n' "$container" >&2
            return 1
        fi
        if [[ "$state" != running ]]; then
            printf '服务容器在就绪前退出：%s（%s）\n' "$container" "$state" >&2
            return 1
        fi
        if docker exec "$container" curl -fsS --max-time 2 http://127.0.0.1:9000/healthz >/dev/null 2>&1; then
            return 0
        fi
        if (( attempt < attempts )); then sleep "$interval"; fi
    done
    printf '等待服务容器就绪超时：%s\n' "$container" >&2
    return 1
}
