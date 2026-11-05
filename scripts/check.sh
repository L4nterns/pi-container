#!/usr/bin/env bash
set -euo pipefail
REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$REPO"
for file in bin/devctl lib/*.sh scripts/check.sh tests/docker-smoke.sh tests/helpers/docker-smoke.sh skills/app-deployment/examples/python/setup.sh; do bash -n "$file"; done
for file in dev-entrypoint.sh services/*.sh tests/fixtures/*.sh; do sh -n "$file"; done
if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import ast
from pathlib import Path
for directory in ('services', 'skills', 'tests/fixtures'):
    for filename in Path(directory).rglob('*.py'):
        ast.parse(filename.read_text(), filename=str(filename))
PY
else
    printf 'Python 3 未安装；跳过语法检查（CI 与服务镜像内执行）。\n' >&2
fi
node --test tests/*.test.mjs
git diff --check
if command -v shellcheck >/dev/null 2>&1; then
    shellcheck -x bin/devctl lib/*.sh dev-entrypoint.sh services/*.sh tests/fixtures/*.sh scripts/check.sh tests/docker-smoke.sh tests/helpers/docker-smoke.sh skills/app-deployment/examples/python/setup.sh
else
    printf 'ShellCheck 未安装；跳过静态 lint（CI 中强制执行）。\n' >&2
fi
