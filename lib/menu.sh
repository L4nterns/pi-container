#!/usr/bin/env bash
# Bash-only UI: compose a frame, diff its lines, then emit one synchronized write.
# No full-screen erase during navigation, no second renderer or host dependency.
menu_screen_open() {
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
    (( rows >= 5 && cols >= 12 )) || { error='「终端太小」请放大后重试。'; return 1; }
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
    menu_clip "${2:-}" "$((cols - 1))"; frame[rows-2]=$'\e[2m'"$MENU_TEXT"$'\e[0m'
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
    local title=$1 saved rows cols visible first i index=${MENU_INDEX:-0} paste=0 error='' MENU_KEY MENU_CHAR MENU_TEXT MENU_WIDTH previous_cols
    local LC_ALL=C.UTF-8
    shift
    local -a items=("$@") frame=() previous_frame=()
    (( ${#items[@]} )) || return 1
    [[ "$index" =~ ^[0-9]+$ ]] && (( index < ${#items[@]} )) || index=0
    menu_tty_begin || return
    menu_draw() {
        menu_dimensions || return
        visible=$((rows - 4)); (( visible <= ${#items[@]} )) || visible=${#items[@]}
        # Like Pi's selector, keep the selection near the centre of the viewport.
        first=$((index - visible / 2)); (( first >= 0 )) || first=0
        (( first + visible <= ${#items[@]} )) || first=$((${#items[@]} - visible))
        menu_frame "$title" "${MENU_NOTICE:-}" "「Esc」${MENU_ESCAPE_LABEL:-返回} · 「↑/↓」选择 · 「Enter」确认"
        if (( ${#items[@]} > visible )); then
            menu_clip "$((index + 1)) / ${#items[@]}  ${MENU_NOTICE:-}" "$((cols - 1))"; frame[rows-2]=$MENU_TEXT
        fi
        for ((i=first; i<first+visible; i++)); do
            menu_row "${items[i]}"
            if (( i == index )); then frame[i-first+2]=$'> \e[7m'"$MENU_TEXT"$'\e[0m'; else frame[i-first+2]="  $MENU_TEXT"; fi
        done
        menu_paint
    }
    trap 'menu_draw || exit 1' WINCH
    menu_draw || return
    while menu_key; do
        case "$MENU_KEY" in
            up) index=$(((index + ${#items[@]} - 1) % ${#items[@]})) ;;
            down) index=$(((index + 1) % ${#items[@]})) ;;
            home) index=0 ;; end) index=$((${#items[@]} - 1)) ;;
            pageup) index=$((index - visible)); (( index >= 0 )) || index=0 ;;
            pagedown) index=$((index + visible)); (( index < ${#items[@]} )) || index=$((${#items[@]} - 1)) ;;
            enter) printf '%s\n' "$index"; return 0 ;;
            escape) return 1 ;;
            *) continue ;;
        esac
        menu_draw || return
    done
    return 1
)
menu_view() (
    local title=$1 file=$2 saved rows cols visible first=0 left=0 longest=0 i last size truncated='' paste=0 error='' MENU_KEY MENU_CHAR MENU_TEXT MENU_WIDTH previous_cols
    local LC_ALL=C.UTF-8
    local -a lines=() frame=() previous_frame=()
    mapfile -t lines < <(tail -n 5000 -- "$file")
    (( ${#lines[@]} )) || lines=('暂无输出')
    size=$(stat -c %s -- "$file") || return
    if (( ${#lines[@]} >= 5000 || size >= 1048576 )); then truncated=' · 仅显示末尾内容'; fi
    for i in "${lines[@]}"; do (( ${#i} <= longest )) || longest=${#i}; done
    menu_tty_begin || return
    menu_draw() {
        menu_dimensions || return
        visible=$((rows - 4)); last=$((${#lines[@]} - visible)); (( last >= 0 )) || last=0
        (( first <= last )) || first=$last
        menu_frame "$title" "${MENU_RESULT:-}$((first + 1))–$((first + visible < ${#lines[@]} ? first + visible : ${#lines[@]})) / ${#lines[@]} 行$truncated" '「Esc」返回 · 「↑/↓」滚动 · 「PgUp/PgDn」翻页'
        for ((i=first; i<first+visible && i<${#lines[@]}; i++)); do menu_clip "${lines[i]:left}" "$((cols - 1))"; frame[i-first+2]=$MENU_TEXT; done
        menu_paint
    }
    trap 'menu_draw || exit 1' WINCH
    menu_dimensions || return
    if [[ ${MENU_VIEW_END:-0} == 1 ]]; then first=$((${#lines[@]} - rows + 4)); (( first >= 0 )) || first=0; fi
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
    local title=$1 note=$2 value='' saved rows cols paste=0 error='' MENU_KEY MENU_CHAR MENU_TEXT MENU_WIDTH previous_cols
    local LC_ALL=C.UTF-8
    local -a frame=() previous_frame=()
    menu_tty_begin || return
    menu_draw() {
        menu_dimensions || return
        menu_frame "$title" "$note" '「Esc」取消 · 「Enter」下一项／空行开始'
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
