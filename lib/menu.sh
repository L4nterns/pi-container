#!/usr/bin/env bash
# Bash-only host UI. A caller may keep one alternate screen for its whole tree;
# standalone selectors still restore the exact terminal mode and primary screen.
menu_screen_open() {
    MENU_SCREEN=1
    printf '\033[?1049h\033[H\033[2J' >&2
}
menu_screen_close() {
    printf '\033[0m\033[?2004l\033[?25h\033[?1049l' >&2
    MENU_SCREEN=0
}
menu_dimensions() {
    read -r rows cols < <(stty size) || return
    [[ "$rows" =~ ^[0-9]+$ && "$cols" =~ ^[0-9]+$ ]] || return 1
    (( rows >= 5 && cols >= 12 )) || { error='「终端太小」请放大后重试。'; return 1; }
}
# Conservative CJK/emoji columns, never bytes. All screens use the same label
# column. Raw log escape sequences are display data, not terminal instructions.
menu_clip() {
    local text=$1 limit=$2 c step n width=0 out='' ansi=$'\e''\[[0-?]*[ -/]*[@-~]'
    while [[ "$text" =~ $ansi ]]; do text=${text//"${BASH_REMATCH[0]}"/}; done
    text=${text//[[:cntrl:]]/ }
    for ((n=0; n<${#text}; n++)); do
        c=${text:n:1}; step=2
        [[ "$c" != [\ -~] ]] || step=1
        if (( width + step > limit )); then break; fi
        # Reserve room for the ellipsis only when more characters remain.
        if (( n + 1 < ${#text} && width + step > limit - 2 )); then break; fi
        out+=$c; width=$((width + step))
    done
    if (( n < ${#text} && limit >= 2 )); then out+='…'; width=$((width + 2)); fi
    MENU_TEXT=$out MENU_WIDTH=$width
}
menu_line() {
    menu_clip "$1" "$((cols - 3))"
    printf '%s' "$MENU_TEXT" >&2
}
menu_row() {
    local label=$1 detail='' pad label_width=16
    if [[ "$label" == *$'\t'* ]]; then
        detail=${label#*$'\t'}; label=${label%%$'\t'*}
        (( cols >= 32 )) || label_width=$((cols / 2 - 3))
        menu_clip "$label" "$label_width"
        pad=$((label_width - MENU_WIDTH + 2))
        printf '%s%*s' "$MENU_TEXT" "$pad" '' >&2
        menu_clip "$detail" "$((cols - label_width - 7))"
        printf '%s' "$MENU_TEXT" >&2
    else menu_line "$label"; fi
}
menu_heading() {
    local rows cols error='' MENU_TEXT MENU_WIDTH
    menu_dimensions || { printf '%s\n' "$error" >&2; return 1; }
    printf '\033[H\033[2J' >&2
    menu_line "$1"; printf '\r\n' >&2
    menu_line "${2:-}"; printf '\r\n\r\n' >&2
}
# Called in a subshell so traps never replace the caller's lifecycle traps.
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
# Blocking first byte; timeouts apply only to an escape continuation. Bracketed
# paste is tracked across reads and can never confirm or cancel an operation.
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
    local title=$1 saved rows cols visible first i index=${MENU_INDEX:-0} paste=0 error='' MENU_KEY MENU_CHAR MENU_TEXT MENU_WIDTH
    local LC_ALL=C.UTF-8
    shift
    local -a items=("$@")
    (( ${#items[@]} )) || return 1
    [[ "$index" =~ ^[0-9]+$ ]] && (( index < ${#items[@]} )) || index=0
    menu_tty_begin || return
    menu_draw() {
        menu_dimensions || return
        visible=$((rows - 4)); (( visible <= ${#items[@]} )) || visible=${#items[@]}
        first=$((index / visible * visible))
        printf '\033[H\033[2J' >&2
        menu_line "$title"; printf '\r\n' >&2
        menu_line "${MENU_NOTICE:-}"; printf '\r\n' >&2
        for ((i=first; i<first+visible && i<${#items[@]}; i++)); do
            if (( i == index )); then printf '> \033[7m' >&2; else printf '  ' >&2; fi
            menu_row "${items[i]}"; printf '\033[0m\r\n' >&2
        done
        menu_line '「↑/↓」选择 · 「Enter」确认 · 「Esc」返回'
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
# Read-only output page, not an editor or an extra confirmation. Esc returns one
# level; Enter deliberately does nothing. Long lines scroll horizontally.
menu_view() (
    local title=$1 file=$2 saved rows cols visible first=0 left=0 longest=0 i last size truncated='' paste=0 error='' MENU_KEY MENU_CHAR MENU_TEXT MENU_WIDTH
    local LC_ALL=C.UTF-8
    local -a lines=()
    mapfile -t lines < <(tail -n 5000 -- "$file")
    (( ${#lines[@]} )) || lines=('「暂无输出」')
    size=$(stat -c %s -- "$file") || return
    if (( ${#lines[@]} >= 5000 || size >= 1048576 )); then truncated=' ·「输出较多」仅显示末尾内容'; fi
    for i in "${lines[@]}"; do (( ${#i} <= longest )) || longest=${#i}; done
    menu_tty_begin || return
    menu_draw() {
        menu_dimensions || return
        visible=$((rows - 4)); last=$((${#lines[@]} - visible)); (( last >= 0 )) || last=0
        (( first <= last )) || first=$last
        printf '\033[H\033[2J' >&2
        menu_line "$title"; printf '\r\n' >&2
        menu_line "「输出」$((first + 1))–$((first + visible < ${#lines[@]} ? first + visible : ${#lines[@]})) / ${#lines[@]} 行$truncated"; printf '\r\n' >&2
        for ((i=first; i<first+visible && i<${#lines[@]}; i++)); do menu_line "${lines[i]:left}"; printf '\r\n' >&2; done
        printf '\033[%s;1H' "$((rows - 1))" >&2
        menu_line '「↑/↓」滚动 · 「PgUp/PgDn」翻页 · 「Esc」返回'
    }
    trap 'menu_draw || exit 1' WINCH
    menu_draw || return
    if [[ ${MENU_VIEW_END:-0} == 1 ]]; then first=$last; menu_draw || return; fi
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
# Small optional build-argument input; no shell evaluation, command history or
# host runtime. Enter accepts a line, empty Enter starts, Esc cancels the build.
menu_input() (
    local title=$1 note=$2 value='' saved rows cols paste=0 error='' MENU_KEY MENU_CHAR MENU_TEXT MENU_WIDTH
    local LC_ALL=C.UTF-8
    menu_tty_begin || return
    menu_draw() {
        menu_dimensions || return
        menu_heading "$title" "$note" || return
        menu_line "> $value"; printf '\r\n' >&2
        printf '\033[%s;1H' "$((rows - 1))" >&2
        menu_line '「Enter」下一项／空行开始 · 「Esc」取消'
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
