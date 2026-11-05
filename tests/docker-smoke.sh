#!/usr/bin/env bash
# Local daemon only; all bind mounts, keys and service state are temporary.
set -euo pipefail
REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck source=tests/helpers/docker-smoke.sh
source "$REPO/tests/helpers/docker-smoke.sh"
TMP=$(mktemp -d)
DEV="dev-smoke-$$"
SERVICE="app-service-smoke-$$"
NETWORK="deploy-smoke-$$"
IMAGE="devctl-test:$$"
SERVICE_IMAGE="app-services-test:$$"
HOST_UID=$(id -u)
HOST_GID=$(id -g)
cleanup() {
    local status=$?
    trap - EXIT
    if (( status != 0 )); then
        smoke_container_diagnostics "$SERVICE"
        smoke_container_diagnostics "$DEV"
    fi
    # Never restart failed workloads for cleanup: preserve their exit evidence
    # and use a separate one-shot helper to restore temporary bind permissions.
    docker rm -f "$DEV" "$SERVICE" >/dev/null 2>&1 || true
    docker run --rm --pull never --network none --user 0 --entrypoint /bin/sh \
        --mount "type=bind,source=$TMP,target=/cleanup" "$IMAGE" -ec \
        'chown -Rh "$1:$2" /cleanup; chmod -R u+rwX /cleanup' \
        sh "$HOST_UID" "$HOST_GID" >/dev/null 2>&1 || true
    docker network rm "$NETWORK" >/dev/null 2>&1 || true
    docker image rm "$IMAGE" "$SERVICE_IMAGE" >/dev/null 2>&1 || true
    if ! rm -rf -- "$TMP"; then
        printf '无法清理测试临时目录：%s\n' "$TMP" >&2
        if (( status == 0 )); then status=1; fi
    fi
    exit "$status"
}
trap cleanup EXIT
mkdir -p "$TMP/agent" "$TMP/workspace/bundle" "$TMP/keys" "$TMP/services"
chmod 755 "$TMP" "$TMP/workspace" "$TMP/workspace/bundle"
export DEV_UID=12345 DEV_GID=12345 DEV_GROUPS=12345 DEV_WORKSPACE="$TMP/workspace"
export DEV_SESSION_DIR=/home/node/.pi/agent/project-sessions/smoke
export DEV_IMAGE="$IMAGE" DEPLOY_IMAGE="$SERVICE_IMAGE" DEPLOY_NETWORK="$NETWORK"
export DEPLOY_DATA_DIR="$TMP/services" DEPLOY_PORT=18080 DEPLOY_PUBLIC_URL='https://app-{app}.example.com'
export DEPLOY_CREDENTIAL_DIR="$TMP/keys"
cd "$REPO"
docker compose -f compose.yaml --env-file .env.example config --quiet
docker compose -f compose.yaml -f compose.deploy.yaml --env-file .env.example config --quiet
docker compose -f compose.services.yaml --env-file .env.example config --quiet
docker build --tag "$IMAGE" .
docker build --file services/Dockerfile --tag "$SERVICE_IMAGE" .
docker network create "$NETWORK" >/dev/null
docker run -d --name "$SERVICE" --init --security-opt no-new-privileges:true \
    --network "$NETWORK" --network-alias app-services \
    --mount "type=bind,source=$TMP/services,target=/srv/app-services" \
    --env "DEPLOY_PUBLIC_URL=$DEPLOY_PUBLIC_URL" "$SERVICE_IMAGE"
smoke_wait_service "$SERVICE"
# Keys never enter the shared Pi agent directory.
docker run --rm --entrypoint ssh-keygen --mount "type=bind,source=$TMP/keys,target=/keys" "$IMAGE" -q -t ed25519 -N '' -f /keys/id_ed25519
ADMIN=$(docker exec "$SERVICE" deploy-admin register "$(<"$TMP/keys/id_ed25519.pub")")
# Parse inside the built image; the Docker host does not need Node or jq.
printf '%s' "$ADMIN" | docker run --rm -i --pull never --network none --user 0 \
    --entrypoint node --mount "type=bind,source=$TMP/keys,target=/keys" "$IMAGE" -e '
let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
  const v=JSON.parse(s),fs=require("node:fs"),d=process.argv[1];
  if(v.user!=="deploy"||!/^ssh-ed25519 [A-Za-z0-9+/=]+$/.test(v.hostKey))throw new Error("Invalid service registration");
  fs.writeFileSync(d+"/user",v.user+"\n",{mode:0o600});
  fs.writeFileSync(d+"/known_hosts","[app-services]:2222 "+v.hostKey+"\n",{mode:0o600});
});' /keys
docker run --rm --entrypoint chown --mount "type=bind,source=$TMP/keys,target=/keys" "$IMAGE" -Rh 12345:12345 /keys
manifest='{"command":["node","server.mjs"],"healthPath":"/health","readyTimeout":10,"env":{"NODE_OPTIONS":"--import ./preflight.mjs"}}'
printf '%s\n' "if(process.getuid()===0||process.getgroups().includes(0))throw new Error('app env loaded before privilege drop');" > "$TMP/workspace/bundle/preflight.mjs"
printf '%s\n' "$manifest" > "$TMP/workspace/bundle/app-deploy.json"
printf '%s\n' "import fs from 'node:fs'; import http from 'node:http'; fs.writeFileSync(process.env.APP_DATA_DIR+'/proof', 'durable'); http.createServer((q,s)=>s.end('persistent service')).listen(Number(process.env.PORT),process.env.HOST);" > "$TMP/workspace/bundle/server.mjs"
chmod 644 "$TMP/workspace/bundle/"*
docker run -d --name "$DEV" --init --security-opt no-new-privileges:true --network "$NETWORK" \
    --mount "type=bind,source=$TMP/agent,target=/home/node/.pi/agent" \
    --mount "type=bind,source=$TMP/workspace,target=/workspace" \
    --mount "type=bind,source=$TMP/keys,target=/run/deploy-credentials,readonly" \
    --env DEV_UID=12345 --env DEV_GID=12345 --env DEV_GROUPS=12345 \
    --entrypoint sleep "$IMAGE" infinity
docker exec "$DEV" dev-entrypoint --dev-shell -ec '
    test "$(id -u)" = 12345
    test "$(id -g)" = 12345
    test "$(id -un)" = node
    test "$USER:$LOGNAME:$HOME" = node:node:/home/node
    getent passwd 12345 | grep -Eq "^node:[^:]*:12345:12345:"
    ssh -F /dev/null -T -G app-services >/dev/null
    grep -Eq "^NoNewPrivs:[[:space:]]+1$" /proc/self/status
    grep -Eq "^CapBnd:[[:space:]]+0+$" /proc/self/status
    touch /home/node/.pi/agent/check
'
docker exec "$DEV" dev-entrypoint --version
docker exec "$DEV" dev-entrypoint --version
docker exec "$DEV" dev-entrypoint --dev-shell -ec 'appctl deploy smoke /workspace/bundle; appctl list; appctl status smoke; appctl logs smoke'
if docker exec "$DEV" dev-entrypoint --dev-shell -c 'ssh -F /dev/null -p 2222 -i /run/deploy-credentials/id_ed25519 -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/run/deploy-credentials/known_hosts "$(tr -d "\n" < /run/deploy-credentials/user)@app-services" id'; then
    printf 'SSH 不应允许任意命令\n' >&2; exit 1
fi
docker stop "$DEV" >/dev/null
# Manage persisted applications with no development container or source mount.
docker run --rm --security-opt no-new-privileges:true \
    --network "$NETWORK" --env DEV_UID=12345 --env DEV_GID=12345 --env DEV_GROUPS=12345 \
    --mount "type=bind,source=$TMP/keys,target=/run/deploy-credentials,readonly" \
    --entrypoint /usr/local/bin/dev-entrypoint "$IMAGE" --appctl restart smoke
docker exec "$SERVICE" node -e '
const fs=require("node:fs");const apps=JSON.parse(fs.readFileSync("/srv/app-services/apps.json"));
const uid=apps.smoke.uid;
if(!Number.isInteger(uid)||uid<20000)throw new Error("Invalid app UID");
if(fs.statSync("/srv/app-services/apps/smoke/data/proof").uid!==uid)throw new Error("App ran with wrong identity");
if(fs.readFileSync("/etc/passwd","utf8").split("\n").find(l=>l.startsWith("app"+uid+":"))?.split(":")[6]!=="/usr/sbin/nologin")throw new Error("App account must not have a shell");
'
docker exec "$SERVICE" curl -fsS -H 'Host: app-smoke.example.com' http://127.0.0.1:8080/ | grep -q 'persistent service'
# Recreate the service container from only its host-mounted state.
docker rm -f "$SERVICE" >/dev/null
docker run -d --name "$SERVICE" --init --security-opt no-new-privileges:true \
    --network "$NETWORK" --network-alias app-services \
    --mount "type=bind,source=$TMP/services,target=/srv/app-services" \
    --env "DEPLOY_PUBLIC_URL=$DEPLOY_PUBLIC_URL" "$SERVICE_IMAGE"
smoke_wait_service "$SERVICE"
docker exec "$SERVICE" curl -fsS -H 'Host: app-smoke.example.com' http://127.0.0.1:8080/ | grep -q 'persistent service'
docker start "$DEV" >/dev/null
docker exec "$DEV" dev-entrypoint --dev-shell -ec 'appctl restart smoke; appctl stop smoke; appctl start smoke'
docker exec "$SERVICE" curl -fsS -H 'Host: app-smoke.example.com' http://127.0.0.1:8080/ | grep -q 'persistent service'
if docker exec "$DEV" dev-entrypoint --dev-shell -ec 'appctl delete smoke'; then
    printf '删除必须显式确认 --yes\n' >&2; exit 1
fi
docker exec "$DEV" dev-entrypoint --dev-shell -ec 'appctl delete smoke --yes; appctl list'
docker exec "$SERVICE" test ! -e /srv/app-services/apps/smoke
for host in app-smoke.example.com app-missing.example.com; do
    if docker exec "$SERVICE" curl -fsS -H "Host: $host" http://127.0.0.1:8080/; then
        printf '已删除或未知应用不应被代理\n' >&2; exit 1
    fi
done
printf 'Docker smoke checks passed. Isolated integration only; .env and public ingress were not used.\n'
