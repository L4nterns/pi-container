#!/usr/bin/env bash
# Small host-side selector: no Node/Pi dependency and no numbered fallback.
# UI goes to stderr; stdout contains only the zero-based selection.
menu_select() (
    local title=$1 saved key sequence char rows cols visible first i index=${MENU_INDEX:-0} paste=0 error=''
    local LC_ALL=C.UTF-8
    shift
    local -a items=("$@")
    (( ${#items[@]} )) || return 1
    [[ "$index" =~ ^[0-9]+$ ]] && (( index < ${#items[@]} )) || index=0
    [[ -t 0 && -t 2 && ${TERM:-dumb} != dumb ]] || { printf '菜单需要支持 ANSI 的交互终端。\n' >&2; return 1; }
    saved=$(stty -g) || return
    # Isolate traps from the caller and restore before handing the TTY to Docker/Pi.
    trap 'stty "$saved"; printf "\033[?2004l\033[?25h\033[?1049l" >&2; [[ -z "$error" ]] || printf "%s\n" "$error" >&2' EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    stty -echo -icanon min 1 time 0 || return
    printf '\033[?1049h\033[?25l\033[?2004h' >&2
    # Conservatively count non-ASCII characters as two columns: CJK/emoji never
    # wrap into the next item. Combining sequences may be shortened, not split by bytes.
    menu_line() {
        local text=${1//[[:cntrl:]]/ } width=0 out='' c step n
        for ((n=0; n<${#text}; n++)); do
            c=${text:n:1}; step=2
            [[ "$c" != [\ -~] ]] || step=1
            (( width + step <= cols - 5 )) || { out+='…'; break; }
            out+=$c; width=$((width + step))
        done
        printf '%s' "$out" >&2
    }
    menu_draw() {
        read -r rows cols < <(stty size) || return
        [[ "$rows" =~ ^[0-9]+$ && "$cols" =~ ^[0-9]+$ ]] || return 1
        (( rows >= 5 && cols >= 12 )) || { error='终端太小，请放大后重试。'; return 1; }
        visible=$((rows - 4)); (( visible <= ${#items[@]} )) || visible=${#items[@]}
        first=$((index / visible * visible))
        printf '\033[H\033[2J' >&2
        menu_line "$title"; printf '\r\n\r\n' >&2
        for ((i=first; i<first+visible && i<${#items[@]}; i++)); do
            if (( i == index )); then printf '> \033[7m' >&2; else printf '  ' >&2; fi
            menu_line "${items[i]}"; printf '\033[0m\r\n' >&2
        done
        menu_line '↑/↓ 选择 · Enter 确认 · Esc 返回'
    }
    trap 'menu_draw || exit 1' WINCH
    menu_draw || return
    while true; do
        # Bash may defer WINCH until this read completes; the next key redraws
        # with current dimensions. Avoid polling reads that can lose escape bytes.
        if IFS= read -r -s -n 1 key; then :
        else
            [[ $? != 1 ]] || return 1
            continue
        fi
        if [[ "$key" == $'\e' ]]; then
            if ! IFS= read -r -s -n 1 -t 0.1 char; then (( paste )) && continue; return 1; fi
            sequence=$char
            if [[ "$char" == '[' || "$char" == O ]]; then
                while IFS= read -r -s -n 1 -t 0.1 char; do
                    sequence+=$char
                    [[ "$char" != [\@-~] ]] || break
                    (( ${#sequence} < 16 )) || break
                done
            fi
            case "$sequence" in
                '[200~') paste=1; continue ;;
                '[201~') paste=0; continue ;;
            esac
            (( ! paste )) || continue
            case "$sequence" in
                '[A'|OA) index=$(((index + ${#items[@]} - 1) % ${#items[@]})) ;;
                '[B'|OB) index=$(((index + 1) % ${#items[@]})) ;;
                '[H'|OH|'[1~') index=0 ;;
                '[F'|OF|'[4~') index=$((${#items[@]} - 1)) ;;
                '[5~') index=$((index - visible)); (( index >= 0 )) || index=0 ;;
                '[6~') index=$((index + visible)); (( index < ${#items[@]} )) || index=$((${#items[@]} - 1)) ;;
                *) continue ;;
            esac
            menu_draw || return
        elif (( ! paste )); then
            case "$key" in
                ''|$'\r') printf '%s\n' "$index"; return 0 ;;
                $'\x04') return 1 ;;
                # Printable characters, including digits, are not menu shortcuts.
            esac
        fi
    done
)
