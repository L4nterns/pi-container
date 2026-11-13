#!/usr/bin/env bash
# Bash-only UI: compose a frame, diff its lines, then emit one synchronized write.
# No full-screen erase during navigation, no second renderer or host dependency.
menu_screen_open() {
    [[ ${MENU_SCREEN:-0} != 1 ]] || return 0
    MENU_SCREEN=1
    printf '\033[?1049h\033[H' >&2
}
menu_screen_close() {
    [[ ${MENU_SCREEN:-0} == 1 ]] || return 0
    printf '\033[0m\033[?2004l\033[?25h\033[?1049l' >&2
    MENU_SCREEN=0
}
menu_dimensions() {
    read -r rows cols < <(stty size) || return
    [[ "$rows" =~ ^[0-9]+$ && "$cols" =~ ^[0-9]+$ ]] || return 1
    (( rows >= 6 && cols >= 12 )) || { error='「终端太小」请放大后重试。'; return 1; }
}
menu_clip() {
    local text=$1 limit=$2 c step n width=0 out='' ansi=$'\e''\[[0-?]*[ -/]*[@-~]'
    while [[ "$text" =~ $ansi ]]; do text=${text//"${BASH_REMATCH[0]}"/}; done
    text=${text//[[:cntrl:]]/ }
    for ((n=0; n<${#text}; n++)); do
        c=${text:n:1}; step=2
        [[ "$c" != [\ -~] ]] || step=1
        if (( width + step > limit )); then break; fi
        if (( n + 1 < ${#text} && width + step > limit - 2 )); then break; fi
        out+=$c; width=$((width + step))
    done
    if (( n < ${#text} && limit >= 2 )); then out+='…'; width=$((width + 2)); fi
    MENU_TEXT=$out MENU_WIDTH=$width
}
menu_row() {
    local label=$1 detail='' pad label_width=16 primary
    if [[ "$label" == *$'\t'* ]]; then
        detail=${label#*$'\t'}; label=${label%%$'\t'*}
        (( cols >= 32 )) || label_width=$((cols / 2 - 3))
        menu_clip "$label" "$label_width"; primary=$MENU_TEXT
        printf -v pad '%*s' "$((label_width - MENU_WIDTH + 2))" ''
        menu_clip "$detail" "$((cols - label_width - 5))"
        MENU_TEXT="$primary$pad$MENU_TEXT"
    else menu_clip "$label" "$((cols - 3))"; fi
}
menu_frame() {
    local i separator
    frame=()
    for ((i=0; i<rows; i++)); do frame+=(''); done
    menu_clip "$1" "$((cols - 1))"; frame[0]=$'\e[1m'"$MENU_TEXT"$'\e[0m'
    printf -v separator '%*s' "$((cols - 1))" ''; separator=${separator// /─}
    frame[1]=$'\e[2m'"$separator"$'\e[0m'
    menu_clip "${2:-}" "$((cols - 1))"; frame[rows-3]=$'\e[2m'"$MENU_TEXT"$'\e[0m'
    frame[rows-2]=$'\e[2m'"$separator"$'\e[0m'
    menu_clip "${3:-}" "$((cols - 1))"; frame[rows-1]=$MENU_TEXT
}
menu_paint() {
    local i chunk='' position
    for ((i=0; i<rows; i++)); do
        if [[ ${previous_frame[i]+set} && ${previous_frame[i]} == "${frame[i]}" && ${previous_cols:-0} == "$cols" ]]; then continue; fi
        printf -v position '\033[%s;1H' "$((i + 1))"
        chunk+="$position"$'\e[0m'"${frame[i]}"$'\e[K'
    done
    if [[ -n "$chunk" ]]; then printf '\033[?2026h%s\033[?2026l' "$chunk" >&2; fi
    previous_frame=("${frame[@]}"); previous_cols=$cols
}
menu_heading() {
    local rows cols error='' MENU_TEXT MENU_WIDTH previous_cols
    local -a frame=() previous_frame=()
    menu_dimensions || { printf '%s\n' "$error" >&2; return 1; }
    menu_frame "$1" "${2:-}" '请等待操作完成'
    menu_paint
}
# Subshell traps do not replace the caller's lifecycle traps.
menu_tty_begin() {
    [[ -t 0 && -t 2 && ${TERM:-dumb} != dumb ]] || { printf '「菜单」需要 ANSI 交互终端。\n' >&2; return 1; }
    saved=$(stty -g) || return
    trap 'stty "$saved"; printf "\033[0m\033[?2004l\033[?25h" >&2; if [[ ${MENU_SCREEN:-0} != 1 ]]; then printf "\033[?1049l" >&2; fi; [[ -z "$error" ]] || printf "%s\n" "$error" >&2' EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    stty -echo -icanon min 1 time 0 || return
    [[ ${MENU_SCREEN:-0} == 1 ]] || printf '\033[?1049h' >&2
    printf '\033[?25l\033[?2004h' >&2
}
# Only escape continuations use a timeout; pasted keys cannot execute actions.
menu_key() {
    local char sequence
    MENU_KEY=''
    while true; do
        if IFS= read -r -s -n 1 char; then break
        elif [[ $? == 1 ]]; then return 1; fi
    done
    MENU_CHAR=$char
    if [[ "$char" == $'\e' ]]; then
        if ! IFS= read -r -s -n 1 -t 0.1 char; then
            (( ! paste )) && MENU_KEY=escape
            return 0
        fi
        sequence=$char
        if [[ "$char" == '[' || "$char" == O ]]; then
            while IFS= read -r -s -n 1 -t 0.1 char; do
                sequence+=$char
                [[ "$char" != [\@-~] ]] || break
                (( ${#sequence} < 16 )) || break
            done
        fi
        case "$sequence" in
            '[200~') paste=1; return 0 ;;
            '[201~') paste=0; return 0 ;;
        esac
        (( ! paste )) || return 0
        case "$sequence" in
            '[A'|OA) MENU_KEY=up ;; '[B'|OB) MENU_KEY=down ;;
            '[C'|OC) MENU_KEY=right ;; '[D'|OD) MENU_KEY=left ;;
            '[H'|OH|'[1~') MENU_KEY=home ;; '[F'|OF|'[4~') MENU_KEY=end ;;
            '[5~') MENU_KEY=pageup ;; '[6~') MENU_KEY=pagedown ;;
        esac
    else
        case "$char" in
            ''|$'\r') (( paste )) || MENU_KEY=enter ;;
            $'\x04') (( paste )) || MENU_KEY=escape ;;
            $'\x7f'|$'\b') (( paste )) || MENU_KEY=backspace ;;
            $'\x15') (( paste )) || MENU_KEY=clear ;;
            *) [[ "$char" == [[:cntrl:]] ]] || MENU_KEY=text ;;
        esac
    fi
    return 0
}
menu_select() (
    local title=$1 saved rows cols visible first i index=0 context_first=0 context_visible=0 context_last=0 context_left=0 context_longest=0 enter_allowed=1 paste=0 error='' MENU_KEY MENU_CHAR MENU_TEXT MENU_WIDTH previous_cols
    local LC_ALL=C.UTF-8
    shift
    local -a items=("$@") disabled=() disabled_indices=() context=() frame=() previous_frame=()
    read -r -a disabled_indices <<< "${MENU_DISABLED:-}"
    for i in "${disabled_indices[@]}"; do
        [[ "$i" =~ ^[0-9]{1,4}$ ]] || continue
        i=$((10#$i)); (( i < ${#items[@]} )) || continue
        disabled[i]=1
    done
    # Every menu starts at its first enabled action. The bounded search also
    # handles an entirely disabled list without making any row actionable.
    menu_seek() {
        local direction=$1 n
        for ((n=0; n<${#items[@]}; n++)); do
            [[ ${disabled[index]:-0} == 1 ]] || return 0
            index=$(((index + direction + ${#items[@]}) % ${#items[@]}))
        done
        index=-1
    }
    if [[ -n "${MENU_CONTEXT:-}" ]]; then
        mapfile -t context <<< "$MENU_CONTEXT"
        for i in "${context[@]}"; do (( ${#i} <= context_longest )) || context_longest=${#i}; done
    fi
    if [[ ${MENU_PATH_LIST:-0} == 1 ]]; then
        for i in "${items[@]}"; do (( ${#i} <= context_longest )) || context_longest=${#i}; done
    fi
    (( ${#items[@]} )) || return 1
    menu_seek 1
    menu_tty_begin || return
    menu_draw() {
        menu_dimensions || return
        visible=$((rows - 5)); (( visible <= ${#items[@]} )) || visible=${#items[@]}
        enter_allowed=1
        if (( ${#context[@]} )); then
            # A contextual action must leave at least one scrollable body row.
            # At 6/7 rows show a recoverable hint, never a blind authorization.
            if (( rows < 8 )); then
                enter_allowed=0; context_visible=0
                menu_frame "$title" '请放大至至少 8 行后查看说明' "「Esc」${MENU_ESCAPE_LABEL:-返回} · 请放大终端"
                menu_clip '说明不可见；Enter 暂不可用' "$((cols - 1))"; frame[2]=$MENU_TEXT
                menu_paint; return 0
            fi
            (( visible <= rows - 7 )) || visible=$((rows - 7))
        fi
        # Like Pi's selector, keep the selection near the centre of the viewport.
        first=$((index - visible / 2)); (( first >= 0 )) || first=0
        (( first + visible <= ${#items[@]} )) || first=$((${#items[@]} - visible))
        menu_frame "$title" "${MENU_NOTICE:-}" "「Esc」${MENU_ESCAPE_LABEL:-返回} · 「↑/↓」选择 · 「Enter」确认"
        if (( ${#items[@]} > visible )); then
            menu_clip "$((index + 1)) / ${#items[@]}  ${MENU_NOTICE:-}" "$((cols - 1))"; frame[rows-3]=$MENU_TEXT
        fi
        for ((i=first; i<first+visible; i++)); do
            if [[ ${MENU_PATH_LIST:-0} == 1 ]]; then menu_clip "${items[i]:context_left}" "$((cols - 3))"
            else menu_row "${items[i]}"; fi
            if [[ ${disabled[i]:-0} == 1 ]]; then frame[i-first+2]=$'  \e[2m'"$MENU_TEXT"$'\e[0m'
            elif (( i == index )); then frame[i-first+2]=$'> \e[7m'"$MENU_TEXT"$'\e[0m'
            else frame[i-first+2]="  $MENU_TEXT"; fi
        done
        context_visible=$((rows - 6 - visible)); (( context_visible >= 0 )) || context_visible=0
        context_last=$((${#context[@]} - context_visible)); (( context_last >= 0 )) || context_last=0
        (( context_first <= context_last )) || context_first=$context_last
        if (( ${#context[@]} && context_visible )); then
            for ((i=0; i<context_visible && i+context_first<${#context[@]}; i++)); do
                menu_clip "${context[i+context_first]:context_left}" "$((cols - 1))"; frame[i+visible+3]=$MENU_TEXT
            done
            menu_clip "「Esc」${MENU_ESCAPE_LABEL:-返回} · 「↑/↓」选择 · 「Enter」确认 · 「PgUp/PgDn」查看清单 $((context_first + 1)) / ${#context[@]} · 「←/→」长行" "$((cols - 1))"
            frame[rows-1]=$MENU_TEXT
        fi
        if [[ ${MENU_PATH_LIST:-0} == 1 ]]; then
            menu_clip "「Esc」返回 · 「↑/↓」选择 · 「Enter」确认 · 「←/→」长路径" "$((cols - 1))"; frame[rows-1]=$MENU_TEXT
        fi
        menu_paint
    }
    trap 'menu_draw || exit 1' WINCH
    menu_draw || return
    while menu_key; do
        case "$MENU_KEY" in
            up) if (( index < 0 )); then index=$((${#items[@]} - 1)); else index=$(((index + ${#items[@]} - 1) % ${#items[@]})); fi; menu_seek -1 ;;
            down) index=$(((index + 1) % ${#items[@]})); menu_seek 1 ;;
            home) index=0; menu_seek 1 ;; end) index=$((${#items[@]} - 1)); menu_seek -1 ;;
            pageup)
                if (( ${#context[@]} )); then context_first=$((context_first - context_visible)); (( context_first >= 0 )) || context_first=0
                elif (( index >= 0 )); then index=$((index - visible)); (( index >= 0 )) || index=0; menu_seek 1; fi ;;
            pagedown)
                if (( ${#context[@]} )); then context_first=$((context_first + context_visible))
                elif (( index >= 0 )); then index=$((index + visible)); (( index < ${#items[@]} )) || index=$((${#items[@]} - 1)); menu_seek -1; fi ;;
            left) (( context_left < 8 )) && context_left=0 || context_left=$((context_left - 8)) ;;
            right) (( context_left + 8 >= context_longest )) || context_left=$((context_left + 8)) ;;
            enter) (( enter_allowed )) || continue; (( index >= 0 )) && [[ ${disabled[index]:-0} != 1 ]] || return 1; printf '%s\n' "$index"; return 0 ;;
            escape) return 1 ;;
            *) continue ;;
        esac
        menu_draw || return
    done
    return 1
)
# Confirmation follows the same first-action focus as other menus. Enter is
# explicit authorization; Esc cancels. Keep the question short and put status,
# risks and the impact snapshot in the separately scrollable body.
menu_confirm() {
    local confirmation_context=${4:-}
    if [[ -n "${MENU_CONTEXT:-}" ]]; then
        [[ -z "$confirmation_context" ]] || confirmation_context+=$'\n\n'
        confirmation_context+=$MENU_CONTEXT
    fi
    MENU_CONTEXT="$confirmation_context" MENU_NOTICE="$1" MENU_ESCAPE_LABEL=取消 menu_select "${2:-确认操作}" "${3:-确认}" >/dev/null
}
# GNU split streams bounded half-MiB chunks. Only the current and previous chunk
# exist: at most 1 MiB, even for unbounded Docker/build output. The collector and
# CLI share one process group and the pipeline joins both before reporting status.
menu_capture() (
    local capture=$1; shift
    set +m
    set -o pipefail
    # Expansion is deliberately performed by split's per-chunk child shell.
    # shellcheck disable=SC2016
    "$@" 2>&1 | PIC_CAPTURE="$capture" split -b 524288 -d -a 12 --filter='\
        if test -f "$PIC_CAPTURE/current"; then mv -f -- "$PIC_CAPTURE/current" "$PIC_CAPTURE/previous" || exit; fi
        printf "%s\\n" "${FILE##*-}" > "$PIC_CAPTURE/sequence" || exit
        exec cat > "$PIC_CAPTURE/current"' - "$capture/chunk-"
)
# The worker has its own process group, but is always joined before returning.
# Only this renderer writes to the terminal; signals terminate/reap the complete
# group before restoring the TTY. Docker daemon work may outlive its CLI client.
menu_progress() (
    local title=$1 file=$2 saved rows cols visible i status=0 worker='' capture='' started=$SECONDS elapsed size sequence paste=0 error='' MENU_TEXT MENU_WIDTH previous_cols
    local LC_ALL=C.UTF-8
    local -a lines=() frame=() previous_frame=()
    shift 2
    menu_tty_begin || return
    # The EXIT trap invokes this callback; it is not dead code.
    # shellcheck disable=SC2317
    progress_cleanup() {
        local code=$? n pending
        trap - EXIT
        trap '' HUP INT TERM
        if [[ -n "$worker" ]]; then
            kill -TERM -- "-$worker" 2>/dev/null || :
            for ((n=0; n<50; n++)); do
                if ! kill -0 -- "-$worker" 2>/dev/null; then break; fi
                sleep 0.1
            done
            kill -KILL -- "-$worker" 2>/dev/null || :
            wait "$worker" 2>/dev/null || :
        fi
        if [[ -n "$capture" ]]; then
            tail -q -c 1048576 -- "$capture/previous" "$capture/current" >"$file" 2>/dev/null || :
            rm -rf -- "$capture"
        fi
        # The renderer may have sampled only one byte from a queued paste/key
        # burst. Drain pending input before any later selector can act on it.
        while true; do
            pending=''
            if IFS= read -r -s -n 4096 -t 0.01 pending; then continue; fi
            # A timed read can consume part of a large burst yet return failure.
            # It is drained only once a read consumed no characters at all.
            [[ -n "$pending" ]] || break
        done
        stty "$saved"
        printf '\033[0m\033[?2004l\033[?25h' >&2
        [[ ${MENU_SCREEN:-0} == 1 ]] || printf '\033[?1049l' >&2
        [[ -z "$error" ]] || printf '%s\n' "$error" >&2
        exit "$code"
    }
    trap progress_cleanup EXIT
    capture=$(umask 077; mktemp -d) || return
    # Bash job control supplies a process group without a host-side runner.
    set -m
    menu_capture "$capture" "$@" </dev/null >/dev/null 2>&1 & worker=$!
    set +m
    progress_draw() {
        if ! menu_dimensions; then
            # Resizing a terminal must not cancel a build or invent a CLI status.
            # Keep the same renderer active, with a compact hint until it fits.
            if [[ "${rows:-}" =~ ^[1-9][0-9]*$ && "${cols:-}" =~ ^[1-9][0-9]*$ ]]; then
                frame=(); for ((i=0; i<rows; i++)); do frame+=(''); done
                menu_clip '终端太小；操作仍在执行，Ctrl+C 中断' "$((cols - 1))"; frame[0]=$MENU_TEXT
                menu_paint
            fi
            return 0
        fi
        error=''
        visible=$((rows - 5)); elapsed=$((SECONDS - started))
        sequence=0; size=0
        if [[ -f "$capture/sequence" ]]; then sequence=$(<"$capture/sequence"); fi
        if [[ "$sequence" =~ ^[0-9]{12}$ ]]; then sequence=$((10#$sequence)); else sequence=0; fi
        # A chunk can rotate between this stat and the read; it is not a CLI
        # failure and must not leak a second writer's diagnostic to the TTY.
        size=$(stat -c %s -- "$capture/current" 2>/dev/null) || size=0
        size=$((sequence * 524288 + size))
        mapfile -t lines < <(tail -q -c 1048576 -- "$capture/previous" "$capture/current" 2>/dev/null | tail -n "$visible")
        (( ${#lines[@]} )) || lines=('等待命令输出…')
        menu_frame "$title" "「正在执行」${elapsed}s · 已输出 ${size} 字节" '「Ctrl+C」中断 · 完成后可查看结果'
        for ((i=0; i<visible && i<${#lines[@]}; i++)); do
            menu_clip "${lines[i]:0:8192}" "$((cols - 1))"; frame[i+2]=$MENU_TEXT
        done
        menu_paint
    }
    while kill -0 "$worker" 2>/dev/null; do
        progress_draw || return
        # Discard operation-time keys: Esc cannot leave maintenance running, and
        # queued Enter/paste must not confirm a later action.
        IFS= read -r -s -n 1 -t 0.2 _ || :
    done
    if wait "$worker"; then :; else status=$?; fi
    # Cleanup still owns the group, including unexpected leftover descendants.
    return "$status"
)
menu_view() (
    local title=$1 file=$2 saved rows cols visible first=0 left=0 longest=0 i last size truncated='' paste=0 error='' MENU_KEY MENU_CHAR MENU_TEXT MENU_WIDTH previous_cols
    local LC_ALL=C.UTF-8
    local -a lines=() frame=() previous_frame=()
    mapfile -t lines < <(tail -c 1048576 -- "$file" | tail -n 5000)
    (( ${#lines[@]} )) || lines=('暂无输出')
    size=$(stat -c %s -- "$file") || return
    if (( ${#lines[@]} >= 5000 || size >= 1048576 )); then truncated=' · 仅显示末尾内容'; fi
    for i in "${lines[@]}"; do (( ${#i} <= longest )) || longest=${#i}; done
    menu_tty_begin || return
    menu_draw() {
        menu_dimensions || return
        visible=$((rows - 5)); last=$((${#lines[@]} - visible)); (( last >= 0 )) || last=0
        (( first <= last )) || first=$last
        menu_frame "$title" "${MENU_RESULT:-}$((first + 1))–$((first + visible < ${#lines[@]} ? first + visible : ${#lines[@]})) / ${#lines[@]} 行$truncated" '「Esc」返回 · 「↑/↓」滚动 · 「PgUp/PgDn」翻页'
        for ((i=first; i<first+visible && i<${#lines[@]}; i++)); do menu_clip "${lines[i]:left}" "$((cols - 1))"; frame[i-first+2]=$MENU_TEXT; done
        menu_paint
    }
    trap 'menu_draw || exit 1' WINCH
    menu_dimensions || return
    if [[ ${MENU_VIEW_END:-0} == 1 ]]; then first=$((${#lines[@]} - rows + 5)); (( first >= 0 )) || first=0; fi
    menu_draw || return
    while menu_key; do
        case "$MENU_KEY" in
            up) (( first <= 0 )) || first=$((first - 1)) ;;
            down) (( first >= last )) || first=$((first + 1)) ;;
            pageup) first=$((first - visible)); (( first >= 0 )) || first=0 ;;
            pagedown) first=$((first + visible)) ;;
            home) first=0; left=0 ;; end) first=$last ;;
            left) left=$((left - 8)); (( left >= 0 )) || left=0 ;;
            right) (( left + 8 >= longest )) || left=$((left + 8)) ;;
            escape) return 0 ;;
            *) continue ;;
        esac
        menu_draw || return
    done
)
menu_input() (
    local title=$1 note=$2 value=${MENU_INPUT_VALUE:-} saved rows cols paste=0 error='' MENU_KEY MENU_CHAR MENU_TEXT MENU_WIDTH previous_cols
    local LC_ALL=C.UTF-8
    local -a frame=() previous_frame=()
    menu_tty_begin || return
    menu_draw() {
        menu_dimensions || return
        menu_frame "$title" "$note" '「Esc」取消 · 「Enter」采用当前输入 · 「Ctrl+U」清空'
        menu_clip "> $value" "$((cols - 1))"; frame[2]=$MENU_TEXT
        menu_paint
    }
    trap 'menu_draw || exit 1' WINCH
    menu_draw || return
    while menu_key; do
        case "$MENU_KEY" in
            enter) printf '%s\n' "$value"; return 0 ;;
            escape) return 1 ;;
            backspace) value=${value%?} ;;
            clear) value='' ;;
            text) (( ${#value} >= 8192 )) || value+=$MENU_CHAR ;;
            *) continue ;;
        esac
        menu_draw || return
    done
    return 1
)
