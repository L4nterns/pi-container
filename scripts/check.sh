#!/usr/bin/env bash
set -euo pipefail
REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$REPO"
bash -n bin/devctl
bash -n lib/session-lifecycle.sh
bash -n lib/deployment.sh
bash -n scripts/check.sh
bash -n tests/docker-smoke.sh
bash -n tests/helpers/docker-smoke.sh
sh -n dev-entrypoint.sh
sh -n services/entrypoint.sh
for file in bin/appctl.mjs services/*.mjs; do node --check "$file"; done
node --test tests/*.test.mjs
git diff --check
if command -v shellcheck >/dev/null 2>&1; then
    shellcheck -x bin/devctl lib/*.sh dev-entrypoint.sh services/entrypoint.sh scripts/check.sh tests/docker-smoke.sh tests/helpers/docker-smoke.sh
else
    printf 'ShellCheck 未安装；跳过静态 lint（CI 中强制执行）。\n' >&2
fi
