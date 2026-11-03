#!/usr/bin/env bash
set -euo pipefail
REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$REPO"
bash -n bin/pi-docker
bash -n lib/session-lifecycle.sh
bash -n scripts/check.sh
bash -n tests/docker-smoke.sh
sh -n docker-entrypoint.sh
node --check skills/vibe-projects/scripts/publish.mjs
node --test tests/*.test.mjs
git diff --check
if command -v shellcheck >/dev/null 2>&1; then
    shellcheck -x bin/pi-docker lib/session-lifecycle.sh docker-entrypoint.sh scripts/check.sh tests/docker-smoke.sh
else
    printf 'ShellCheck 未安装；跳过静态 lint（CI 中强制执行）。\n' >&2
fi
