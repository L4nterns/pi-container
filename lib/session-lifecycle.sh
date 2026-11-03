#!/usr/bin/env bash

# Host-only coordination. A short exclusive lock covers up/stop and each session
# holds a separate lease for its entire docker exec, including the startup gap.
session_lifecycle_init() {
    if [[ -n "${SESSION_LIFECYCLE_FD:-}" ]]; then
        exec {SESSION_LIFECYCLE_FD}>&-
    fi
    SESSION_RUNTIME_DIR=$1
    mkdir -p -- "$SESSION_RUNTIME_DIR"
    chmod 700 "$SESSION_RUNTIME_DIR"
    exec {SESSION_LIFECYCLE_FD}>>"$SESSION_RUNTIME_DIR/lifecycle.lock"
    SESSION_LEASE=
    SESSION_LEASE_FD=
}

session_lifecycle_lock() {
    flock -x "$SESSION_LIFECYCLE_FD"
}

session_lifecycle_unlock() {
    flock -u "$SESSION_LIFECYCLE_FD"
}

session_start() {
    local status
    session_lifecycle_lock || return
    if SESSION_LEASE=$(mktemp "$SESSION_RUNTIME_DIR/session.XXXXXXXX") &&
        exec {SESSION_LEASE_FD}>>"$SESSION_LEASE" &&
        flock -x "$SESSION_LEASE_FD" && "$@"; then
        status=0
    else
        status=$?
        session_release_lease
    fi
    session_lifecycle_unlock
    return "$status"
}

session_release_lease() {
    if [[ -n "${SESSION_LEASE_FD:-}" ]]; then
        exec {SESSION_LEASE_FD}>&-
        SESSION_LEASE_FD=
    fi
    if [[ -n "${SESSION_LEASE:-}" ]]; then
        rm -f -- "$SESSION_LEASE"
        SESSION_LEASE=
    fi
}

# Caller must hold the lifecycle lock. Unlocked lease files are crash leftovers.
session_active_count() {
    local lease fd active=0
    for lease in "$SESSION_RUNTIME_DIR"/session.*; do
        [[ -f "$lease" ]] || continue
        exec {fd}>>"$lease" || return
        if flock -n -x "$fd"; then
            rm -f -- "$lease"
        else
            active=$((active + 1))
        fi
        exec {fd}>&-
    done
    printf '%s' "$active"
}

session_finish() {
    local remaining
    [[ -n "${SESSION_LEASE:-}" ]] || return 0
    session_lifecycle_lock || return 0
    session_release_lease
    remaining=$(session_active_count) || remaining=1
    if [[ "$remaining" == 0 ]]; then
        "$@" || true
    fi
    session_lifecycle_unlock || true
}

session_require_idle() {
    local remaining status
    session_lifecycle_lock || return
    remaining=$(session_active_count) || remaining=1
    if [[ "$remaining" != 0 ]]; then
        session_lifecycle_unlock
        printf '当前项目仍有 %s 个活动会话；请先退出它们再执行此操作。\n' "$remaining" >&2
        return 1
    fi
    if "$@"; then
        status=0
    else
        status=$?
    fi
    session_lifecycle_unlock
    return "$status"
}
