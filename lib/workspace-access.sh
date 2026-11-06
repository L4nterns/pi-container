#!/bin/sh
# Container-only preparation for a root-owned host project. No host packages,
# recursive chown, capabilities in user sessions, or access outside the bind.
set -eu
# Git's system trust configuration is non-secret and must be readable by the
# unprivileged session even when the host caller uses umask 077.
umask 022
[ "$(id -u)" = 0 ] || { echo 'Workspace initialization requires container root' >&2; exit 1; }
case "${1:-}" in
    ''|*[!0-9]*|0*) echo 'Invalid workspace UID' >&2; exit 1 ;;
esac
[ "$#" = 1 ] || { echo 'Usage: pic-workspace-init <uid>' >&2; exit 1; }
uid=$1
if [ ! -d /workspace ] || [ -L /workspace ]; then echo 'Missing workspace directory' >&2; exit 1; fi
# Physical traversal: never follow repository symlinks into other host files.
# Defaults allow newly created root-owned files to inherit development access
# when their creation mode allows it; rescan on every pic terminal connection as well.
find /workspace -xdev -type d -uid 0 -exec setfacl -P -m "u:$uid:rwx,d:u:$uid:rwx" -- {} +
find /workspace -xdev -type f -uid 0 -exec setfacl -P -m "u:$uid:rwX" -- {} +
# The mounted source is trusted by the host operator, even when root owns .git.
# Scope Git's ownership exception to this workspace, never safe.directory=*.
git config --system --replace-all safe.directory /workspace
git config --system --add safe.directory '/workspace/*'
