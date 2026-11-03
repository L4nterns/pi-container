#!/usr/bin/env bash
# Run only against a local development/CI Docker daemon. All state lives in tmp.
set -euo pipefail
REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
TMP=$(mktemp -d)
PROJECT="pi-smoke-$$"
IMAGE="pi-docker-test:$$"
PUID=$(id -u)
PGID=$(id -g)
PI_GROUPS=$(id -G | tr ' ' ',')
cleanup() {
    local status=$?
    trap - EXIT
    # Restore temporary bind-mount ownership even after a failed UID test or a
    # stopped container, before removing the only privileged cleanup process.
    docker start "$PROJECT" >/dev/null 2>&1 || true
    docker exec --user 0 "$PROJECT" chown -Rh "$PUID:$PGID" \
        /home/node/.pi/agent /workspace /vibe-projects >/dev/null 2>&1 || true
    docker rm -f "$PROJECT" >/dev/null 2>&1 || true
    docker image rm "$IMAGE" >/dev/null 2>&1 || true
    if ! rm -rf -- "$TMP"; then
        printf '无法清理测试临时目录：%s\n' "$TMP" >&2
        if (( status == 0 )); then status=1; fi
    fi
    exit "$status"
}
trap cleanup EXIT
mkdir -p "$TMP/agent" "$TMP/workspace/site" "$TMP/sites"
export PUID PGID PI_GROUPS PI_WORKSPACE PI_SESSION_DIR
export PI_DOCKER_IMAGE="$IMAGE"
PI_WORKSPACE="$TMP/workspace"
PI_SESSION_DIR=/home/node/.pi/agent/project-sessions/smoke
export VIBE_PROJECTS_HOST_DIR="$TMP/sites"
export VIBE_PUBLIC_URL=https://example.com
cd "$REPO"
docker compose -f compose.yaml --env-file .env.example config --quiet
docker compose -f compose.yaml -f compose.vibe.yaml --env-file .env.example config --quiet
docker build --tag "$IMAGE" .
docker run -d --name "$PROJECT" --init --security-opt no-new-privileges:true \
    --mount "type=bind,source=$TMP/agent,target=/home/node/.pi/agent" \
    --mount "type=bind,source=$TMP/workspace,target=/workspace" \
    --mount "type=bind,source=$TMP/sites,target=/vibe-projects" \
    --env "PUID=$PUID" --env "PGID=$PGID" --env "PI_GROUPS=$PI_GROUPS" \
    --env "VIBE_PUBLIC_URL=$VIBE_PUBLIC_URL" \
    --entrypoint sleep "$IMAGE" infinity
# Use a non-default UID to test that ordinary sessions actually drop root.
docker exec --env PUID=12345 --env PGID=12345 --env PI_GROUPS=12345 "$PROJECT" \
    /usr/local/bin/pi-entrypoint --pi-docker-shell -ec 'test "$(id -u)" = 12345; grep -Eq "^NoNewPrivs:[[:space:]]+1$" /proc/self/status; touch /home/node/.pi/agent/shell-check'
docker exec "$PROJECT" /usr/local/bin/pi-entrypoint --version
docker exec "$PROJECT" /usr/local/bin/pi-entrypoint --version
printf '<h1>smoke</h1>\n' > "$TMP/workspace/site/index.html"
docker exec --user "$PUID:$PGID" "$PROJECT" node /opt/pi-docker/skills/vibe-projects/scripts/publish.mjs smoke /workspace/site
test -s "$TMP/sites/smoke/index.html"
printf 'ghp_%036d\n' 0 > "$TMP/workspace/site/app.js"
if docker exec --user "$PUID:$PGID" "$PROJECT" node /opt/pi-docker/skills/vibe-projects/scripts/publish.mjs smoke /workspace/site; then
    printf '凭据检测应阻止发布\n' >&2
    exit 1
fi
test ! -e "$TMP/sites/smoke/app.js"
docker stop "$PROJECT" >/dev/null
test -s "$TMP/sites/smoke/index.html"
printf 'Docker smoke checks passed.\n'
