#!/usr/bin/env bash
# Local Docker only. No real .env, service data, published ports or public ingress.
set -euo pipefail
REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck source=tests/helpers/docker-smoke.sh
source "$REPO/tests/helpers/docker-smoke.sh"
TMP=$(mktemp -d)
DEV="dev-smoke-$$"
SERVICE="app-service-smoke-$$"
NETWORK="deploy-smoke-$$"
IMAGE="pic-test:$$"
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
    docker rm -f "$DEV" "$SERVICE" >/dev/null 2>&1 || true
    # Restore temporary bind permissions in a separate helper; never restart a
    # failed workload and destroy its exit evidence merely to clean files.
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
mkdir -p "$TMP/agent" "$TMP/workspace" "$TMP/keys" "$TMP/services"
cp -R "$REPO/skills/app-deployment/examples/python" "$TMP/workspace/reviewed"
cp "$REPO/tests/fixtures/http-protocols.py" "$TMP/workspace/reviewed/server.py"
chmod 755 "$TMP" "$TMP/workspace" "$TMP/workspace/reviewed"
chmod 644 "$TMP/workspace/reviewed/"*
export PIC_UID=12345 PIC_GID=12345 PIC_GROUPS=12345 PIC_WORKSPACE="$TMP/workspace"
export PIC_HISTORY_DIR=/home/node/.pi/agent/project-history/smoke
export PIC_IMAGE="$IMAGE" DEPLOY_IMAGE="$SERVICE_IMAGE" DEPLOY_NETWORK="$NETWORK"
export DEPLOY_DATA_DIR="$TMP/services" DEPLOY_PORT=18080 DEPLOY_PUBLIC_URL='https://app-{app}.example.com'
export DEPLOY_CREDENTIAL_DIR="$TMP/keys"
cd "$REPO"
docker compose -f compose.yaml --env-file .env.example config --quiet
docker compose -f compose.yaml -f compose.deploy.yaml --env-file .env.example config --quiet
docker compose -f compose.services.yaml --env-file .env.example config --quiet
docker build --tag "$IMAGE" .
docker build --file services/Dockerfile --tag "$SERVICE_IMAGE" .
if rejected=$(docker run --rm --security-opt no-new-privileges:true --network none "$SERVICE_IMAGE" 2>&1); then
    printf 'Misconfigured service unexpectedly allowed no-new-privileges\n' >&2; exit 1
fi
[[ "$rejected" == *'do not set no-new-privileges'* ]] || { printf '%s\n' "$rejected" >&2; exit 1; }
docker network create "$NETWORK" >/dev/null
start_service() {
    docker run -d --name "$SERVICE" --init \
        --network "$NETWORK" --network-alias app-services \
        --mount "type=bind,source=$TMP/services,target=/srv/app-services" "$SERVICE_IMAGE"
    smoke_wait_service "$SERVICE" 180
}
start_service
docker cp "$REPO/config/nginx-apps.conf" "$SERVICE:/run/host-nginx-template.conf"
docker exec -i "$SERVICE" sh -s -- /run/host-nginx-template.conf < "$REPO/tests/fixtures/check-host-nginx.sh"
# The image provides management tools, not a preselected application runtime.
docker exec "$SERVICE" sh -ec 'if command -v node; then exit 1; fi; if python3 -m ensurepip --version >/dev/null 2>&1; then exit 1; fi'
docker run --rm --entrypoint ssh-keygen --mount "type=bind,source=$TMP/keys,target=/keys" "$IMAGE" -q -t ed25519 -N '' -f /keys/id_ed25519
HOST_KEY=$(docker exec "$SERVICE" deploy-register "$(<"$TMP/keys/id_ed25519.pub")")
[[ "$HOST_KEY" =~ ^ssh-ed25519\ [A-Za-z0-9+/]+={0,2}$ ]] || { printf 'Invalid SSH host key\n' >&2; exit 1; }
printf '[app-services]:2222 %s\n' "$HOST_KEY" > "$TMP/keys/known_hosts"
docker run --rm --entrypoint /bin/sh --mount "type=bind,source=$TMP/keys,target=/keys" "$IMAGE" -ec \
    'chown -R 0:0 /keys; chmod 0700 /keys; chmod 0600 /keys/id_ed25519 /keys/known_hosts'
docker run -d --name "$DEV" --init --security-opt no-new-privileges:true --network "$NETWORK" \
    --mount "type=bind,source=$TMP/agent,target=/home/node/.pi/agent" \
    --mount "type=bind,source=$TMP/workspace,target=/workspace" \
    --mount "type=bind,source=$TMP/keys,target=/run/deploy-credentials,readonly" \
    --tmpfs /run/pic-ssh:rw,noexec,nosuid,nodev,mode=0700 \
    --env PIC_UID=12345 --env PIC_GID=12345 --env PIC_GROUPS=12345 \
    --entrypoint sleep "$IMAGE" infinity
client() { docker exec -i "$DEV" pic-entrypoint --dev-shell -ec "$1"; }
# Selected-project Shell entry compares the real host/container bind identity.
# Validate that contract with native Docker, including a stale bind at the same
# pathname, before the workspace is used by any workload.
workspace_identity=$(stat -Lc '%d:%i' -- "$TMP/workspace")
[[ "$(docker exec "$DEV" stat -Lc '%d:%i' -- /workspace)" == "$workspace_identity" ]]
mv -- "$TMP/workspace" "$TMP/workspace-original"; mkdir -- "$TMP/workspace"
[[ "$(stat -Lc '%d:%i' -- "$TMP/workspace")" != "$workspace_identity" ]]
[[ "$(docker exec "$DEV" stat -Lc '%d:%i' -- /workspace)" == "$workspace_identity" ]]
rmdir -- "$TMP/workspace"; mv -- "$TMP/workspace-original" "$TMP/workspace"
# Root-owned project metadata is accessible only after explicit ACL preparation.
docker exec "$DEV" sh -ec '
    chown 0:0 /workspace; chmod 0700 /workspace
    printf original > /workspace/root-only; chmod 0600 /workspace/root-only
    printf private > /tmp/outside-workspace; chmod 0600 /tmp/outside-workspace
    ln -s /tmp/outside-workspace /workspace/external-link
    mkdir /workspace/root-project
    git -C /workspace/root-project init --quiet
'
if client 'cat /workspace/root-only'; then echo 'Root-only workspace unexpectedly readable before initialization' >&2; exit 1; fi
docker exec "$DEV" /usr/local/bin/pic-workspace-init 12345
# Variables are evaluated by the development shell, not the host.
# shellcheck disable=SC2016
client '
    test "$(cat /workspace/root-only)" = original
    test "$(stat -c %u /workspace/root-only)" = 0
    printf updated > /workspace/root-only
    printf new > /workspace/created-by-developer
    test "$(stat -c %u /workspace/created-by-developer)" = 12345
    if cat /workspace/external-link; then exit 1; fi
    git -C /workspace/root-project status --porcelain
    test "$(stat -c %u:%a /run/pic-ssh/id_ed25519)" = 12345:600
'
docker exec "$DEV" sh -ec '
    test "$(stat -c %u:%g:%a /run/deploy-credentials/id_ed25519)" = 0:0:600
    test "$(stat -c %a /tmp/outside-workspace)" = 600
    test "$(stat -c %u /workspace/root-project/.git)" = 0
'
# Host-root's fixed runtime identity also works without root or group 0.
docker exec "$DEV" /usr/local/bin/pic-workspace-init 1000
docker exec -e PIC_UID=1000 -e PIC_GID=1000 -e PIC_GROUPS=1000 "$DEV" pic-entrypoint --dev-shell -ec '
    test "$(id -u):$(id -g):$(id -G)" = 1000:1000:1000
    printf root-session > /workspace/root-only
    test "$(stat -c %u /workspace/root-only)" = 0
    git -C /workspace/root-project status --porcelain
    ssh app-services "test \"\$(id -u)\" = 19000; sudo -n true"
'
# Bootstrap with the real CLI before replacing Pi for the lifetime test. The
# hosted-process substitute cannot also execute the bootstrap's "pi install".
printf '\n--- Smoke: install default Pi packages with the real CLI ---\n'
docker exec "$DEV" pic-entrypoint --version
docker exec "$DEV" pic-entrypoint --version
# Template literals are evaluated by Node in the container, not the host Shell.
# shellcheck disable=SC2016
docker exec --user 12345:12345 "$DEV" node --input-type=module -e '
import { readFile } from "node:fs/promises";
const manifest = JSON.parse(await readFile("/opt/pic/config/pi-bootstrap.json", "utf8"));
const agent = "/home/node/.pi/agent";
const state = JSON.parse(await readFile(`${agent}/.pic-packages.json`, "utf8"));
const settings = JSON.parse(await readFile(`${agent}/settings.json`, "utf8"));
if (state.version !== 1 || !Array.isArray(state.installed) || !Array.isArray(settings.packages)) throw new Error("Invalid package bootstrap state");
for (const { source } of manifest.packages) {
    if (!state.installed.includes(source) || !settings.packages.some(p => (typeof p === "string" ? p : p.source) === source)) throw new Error("Default package was not installed and recorded");
}
'
printf '\n--- Smoke: detached process lifetime with synthetic Pi ---\n'
# Live process lifetime is independent from the docker exec that created it.
# Only this disposable container's Pi symlink is temporarily replaced.
docker cp "$REPO/tests/fixtures/pi-live-smoke.sh" "$DEV:/tmp/pi-live-smoke.sh"
docker exec "$DEV" sh -ec 'mv /usr/local/bin/pi /usr/local/bin/pi.original; install -m 0755 /tmp/pi-live-smoke.sh /usr/local/bin/pi'
docker exec "$DEV" pic-entrypoint --pic-session start smoke-live
count=$(docker exec --user 12345:12345 "$DEV" pic-session count)
[[ "$count" == 1 ]] || { echo 'Detached Pi did not survive exec exit' >&2; exit 1; }
first_pid=$(docker exec "$DEV" sh -ec 'for i in 1 2 3 4 5; do test ! -s /tmp/live-pi-pid || { cat /tmp/live-pi-pid; exit 0; }; sleep .1; done; exit 1')
docker exec "$DEV" sh -ec 'kill -0 "$1"' sh "$first_pid"
docker exec --user 12345:12345 "$DEV" sh -ec 'kill -TERM "$1"' sh "$first_pid"
for _ in 1 2 3 4 5; do
    [[ "$(docker exec --user 12345:12345 "$DEV" pic-session count)" == 0 ]] && break
    sleep .1
done
[[ "$(docker exec --user 12345:12345 "$DEV" pic-session count)" == 0 ]]
docker exec "$DEV" sh -ec 'rm /usr/local/bin/pi; mv /usr/local/bin/pi.original /usr/local/bin/pi'
# Variables expand in the remote shell, not the host.
# shellcheck disable=SC2016
client '
    test "$(id -u):$(id -g):$(id -un)" = 12345:12345:node
    test "$USER:$LOGNAME:$HOME" = node:node:/home/node
    grep -Eq "^NoNewPrivs:[[:space:]]+1$" /proc/self/status
    grep -Eq "^CapBnd:[[:space:]]+0+$" /proc/self/status
    test "$(ssh app-services id -u)" = 19000
    test "$(ssh app-services sudo -n id -u)" = 0
    ssh -tt app-services test -t 0
    ssh app-services "printf disposable > ~/staging-proof"
'
status=0
client 'ssh app-services "exit 37"' || status=$?
[[ "$status" == 37 ]] || { printf 'SSH command exit status was not preserved\n' >&2; exit 1; }
# Identical Bash argument/stdin/exit semantics, over exec and over real SSH.
for mode in --dev-shell --service-shell; do
    docker exec -t "$DEV" pic-entrypoint "$mode" -c 'test -t 0 && test -t 1'
    # shellcheck disable=SC2016
    docker exec -i "$DEV" pic-entrypoint "$mode" -lc \
        'test "$#" = 3 && test "$1" = "two words" && test -z "$2" && test "$3" = '\''$HOME;*'\'' && ! test -t 0' \
        bash 'two words' '' '$HOME;*'
    status=0
    docker exec -i "$DEV" pic-entrypoint "$mode" -s -- 'stdin argument' <<'BASH' || status=$?
[[ "$1" == 'stdin argument' ]] || exit 91
exit 37
BASH
    [[ "$status" == 37 ]] || { printf 'Bash stdin/exit contract failed: %s\n' "$mode" >&2; exit 1; }
done
# Assert actual skill discovery and on-demand instructions without model/API calls.
client 'node --input-type=module -e '\''
import {loadSkills,formatSkillsForPrompt} from "/opt/pic/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const result=loadSkills({cwd:"/workspace",agentDir:"/tmp/skill-check-empty",skillPaths:["/opt/pic/skills/app-deployment"]});
const skill=result.skills.find(s=>s.name==="app-deployment");
if(!skill||result.diagnostics.some(d=>d.type==="warning"))throw new Error("Skill discovery failed");
const prompt=formatSkillsForPrompt([skill]);
if(!prompt.includes("app-deployment")||prompt.includes("Stopping preserves"))throw new Error("Instructions must load on demand");
'\'''
client 'scp -r /workspace/reviewed app-services:upload; printf "get upload/server.py /tmp/downloaded-server.py\n" | sftp -b - app-services; cmp /workspace/reviewed/server.py /tmp/downloaded-server.py'
# Exercise SSH dependency installation and persistent startup preparation with a
# Python virtual environment. Nothing executes an application as root.
client "ssh app-services 'sudo -n bash -s'" <<'REMOTE'
set -euo pipefail
umask 077
base=/srv/app-services
stage=/home/deploy/upload
install -o root -g root -m 0700 "$stage/setup.sh" "$base/setup.d/10-demo.sh"
bash -eu "$base/setup.d/10-demo.sh"
install -o root -g root -m 0644 "$stage/server.py" "$base/apps/demo/code/server.py"
install -o root -g root -m 0600 "$stage/supervisor.conf" "$base/supervisor/demo.conf"
printf 'printf restored > /etc/environment-proof\n' > "$base/setup.d/20-proof.sh"
chmod 700 "$base/setup.d/20-proof.sh"
bash "$base/setup.d/20-proof.sh"
supervisorctl reread
supervisorctl update demo
REMOTE
client "ssh app-services 'sudo -n bash -s'" <<'REMOTE'
set -euo pipefail
for i in {1..50}; do
    if curl -fsS --max-time 1 http://127.0.0.1:20000/; then break; fi
    sleep .2
done
curl -fsS --max-time 1 http://127.0.0.1:20000/
base=/srv/app-services
install -o root -g root -m 0600 "/home/deploy/upload/nginx.conf" "$base/nginx/demo.conf"
nginx -t -c /opt/app-services/nginx.conf
nginx -s reload -c /opt/app-services/nginx.conf
pid=$(supervisorctl pid demo)
grep -Eq '^Uid:[[:space:]]+20000[[:space:]]+20000' "/proc/$pid/status"
grep -Eq '^NoNewPrivs:[[:space:]]+1$' "/proc/$pid/status"
grep -Eq '^CapBnd:[[:space:]]+0+$' "/proc/$pid/status"
test "$(stat -c %u "$base/apps/demo/data/starts")" = 20000
if sudo -u app-demo sudo -n id -u; then echo 'App account must not gain root' >&2; exit 1; fi
REMOTE
wait_app() {
    local attempt
    for (( attempt=0; attempt<60; attempt++ )); do
        if docker exec "$SERVICE" curl -fsS --max-time 1 -H 'Host: app-demo.example.com' http://127.0.0.1:8080/ 2>/dev/null | grep -q 'Hello from Python'; then return 0; fi
        sleep .2
    done
    printf 'Application gateway did not become healthy\n' >&2; return 1
}
wait_app
docker exec -i "$SERVICE" python3 < "$REPO/tests/fixtures/check-protocols.py"
client "ssh app-services 'sudo kill -KILL \$(sudo supervisorctl pid demo)'"
# Confirm a new process has actually served a request, not just a PID change.
client "ssh app-services 'sudo -n bash -s'" <<'REMOTE'
set -euo pipefail
for i in {1..50}; do
    if [[ $(cat /srv/app-services/apps/demo/data/starts) -ge 2 ]]; then exit 0; fi
    sleep .2
done
exit 1
REMOTE
wait_app
# Test fixture changed the temporary workspace owner to root. Remove source
# through container root so this also runs on a non-root CI host, then stop it.
docker exec "$DEV" sh -ec 'rm -rf /workspace/reviewed; test ! -e /workspace/reviewed'
docker stop "$DEV" >/dev/null
# Same path as the service-terminal menu: no source/Pi bind, numeric NSS initialization.
standalone() {
    docker run --rm --init --pull never -i --security-opt no-new-privileges:true --network "$NETWORK" \
        --tmpfs /run/pic-ssh:rw,noexec,nosuid,nodev,mode=0700 \
        --env PIC_UID=12345 --env PIC_GID=12345 --env PIC_GROUPS=12345 \
        --mount "type=bind,source=$TMP/keys,target=/run/deploy-credentials,readonly" \
        --entrypoint /usr/local/bin/pic-entrypoint "$IMAGE" --service-shell "$@"
}
standalone -c 'sudo supervisorctl restart demo'
wait_app
# Fresh image filesystem: installed packages and account records must be restored.
docker rm -f "$SERVICE" >/dev/null
start_service
wait_app
standalone -s < "$REPO/tests/fixtures/check-service-recovery.sh"
[[ "$(docker exec "$SERVICE" cat /srv/app-services/ssh/ssh_host_ed25519_key.pub | cut -d' ' -f1-2)" == "$HOST_KEY" ]]
standalone -c 'sudo -n bash -s' <<'DISABLE'
set -euo pipefail
before=$(supervisorctl pid demo)
read -r name enabled revision < <(deploy-apps list)
[[ "$name" == demo && "$enabled" == true ]]
deploy-apps set demo false "$revision"
[[ "$(supervisorctl pid demo)" == "$before" ]]
# Policy edits never stop/restart a currently running app. Stop is explicit.
supervisorctl stop demo
mv /srv/app-services/nginx/demo.conf /srv/app-services/nginx/demo.disabled
nginx -t -c /opt/app-services/nginx.conf
nginx -s reload -c /opt/app-services/nginx.conf
DISABLE
docker rm -f "$SERVICE" >/dev/null
start_service
standalone -c 'sudo -n bash -s' <<'STOPPED'
set -euo pipefail
status=$(supervisorctl status demo) || test "$?" = 3
[[ "$status" == *STOPPED* ]]
STOPPED
for host in app-demo.example.com app-missing.example.com; do
    code=$(docker exec "$SERVICE" curl -sS --max-time 2 -o /dev/null -w '%{http_code}' -H "Host: $host" http://127.0.0.1:8080/)
    [[ "$code" == 404 ]] || { printf 'Expected 404, got %s\n' "$code" >&2; exit 1; }
done
# Re-enable policy without starting now, then prove the next fresh container starts it.
standalone -c 'sudo -n bash -s' <<'ENABLE'
set -euo pipefail
read -r name enabled revision < <(deploy-apps list)
[[ "$name" == demo && "$enabled" == false ]]
deploy-apps set demo true "$revision"
status=$(supervisorctl status demo) || test "$?" = 3
[[ "$status" == *STOPPED* ]]
ENABLE
docker rm -f "$SERVICE" >/dev/null
start_service
for attempt in {1..60}; do
    if docker exec "$SERVICE" curl -fsS --max-time 1 http://127.0.0.1:20000/ >/dev/null; then break; fi
    sleep .2
done
docker exec "$SERVICE" curl -fsS --max-time 1 http://127.0.0.1:20000/ >/dev/null
# Explicit test authorization: delete only this isolated fixture application.
standalone -c 'sudo -n bash -s' <<'REMOTE'
set -euo pipefail
supervisorctl stop demo
rm /srv/app-services/supervisor/demo.conf
supervisorctl reread
supervisorctl update
rm /srv/app-services/nginx/demo.disabled /srv/app-services/setup.d/10-demo.sh
rm -rf /srv/app-services/apps/demo
userdel app-demo
if getent group app-demo >/dev/null; then groupdel app-demo; fi
test ! -e /srv/app-services/apps/demo
test -s /srv/app-services/control/authorized_keys
test -d /home/deploy
REMOTE
printf 'Docker smoke checks passed. Isolated SSH/SFTP, sudo, Python, recovery and deletion; public ingress was not used.\n'
