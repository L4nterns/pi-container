#!/usr/bin/env bash
# A project/container-scoped host observer, not a Docker socket in the container.
# Its function bodies and Compose identity are inherited from the launching pc.
# It never starts a container, Pi, deployment or package, nor retries a request.
pc_idle_monitor_start() {
    local expected=${SESSION_CONTAINER_ID:-}
    [[ "$expected" =~ ^[a-zA-Z0-9_.-]+$ ]] || return 0
    (
        trap - EXIT INT TERM
        trap '' HUP
        local fd variable monitor_fd active running observed error pidfile
        # Do not retain a terminal lease or the launcher's operation locks.
        for variable in PC_OPERATION_FD SESSION_LIFECYCLE_FD SESSION_LEASE_FD services_fd; do
            fd=${!variable:-}
            if [[ -n "$fd" ]]; then exec {fd}>&-; fi
        done
        unset PC_OPERATION_FD SESSION_LIFECYCLE_FD SESSION_LEASE_FD SESSION_LEASE
        session_lifecycle_init "$REPO/.runtime/$PROJECT"
        exec {monitor_fd}>>"$SESSION_RUNTIME_DIR/idle-${expected}.lock"
        flock -n -x "$monitor_fd" || exit 0
        error="$SESSION_RUNTIME_DIR/idle-${expected}.error"
        pidfile="$SESSION_RUNTIME_DIR/idle-${expected}.pid"
        printf '%s\n' "$BASHPID" > "$pidfile"
        trap 'rm -f -- "$pidfile"' EXIT
        while true; do
            exec 2>"$error" # Retain only the latest check's diagnostic, not a transcript.
            pc_operation_lock
            session_lifecycle_lock
            observed=$("${CURRENT[@]}" ps -q pi) || break
            [[ "$observed" == "$expected" ]] || break
            running=$(docker inspect --format '{{.State.Running}}' "$expected") || break
            [[ "$running" == true ]] || break
            active=$(session_active_count) || active=unknown
            if [[ "$active" == 0 ]]; then compose_stop_if_idle; fi
            session_lifecycle_unlock
            pc_operation_unlock
            sleep 2
        done
        # No lock survives monitor exit, including errors, uninstall or replacement.
    ) </dev/null >/dev/null 2>/dev/null &
}
