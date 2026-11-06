#!/usr/bin/env python3
"""Edit native Supervisor autostart only; never restart a running application."""
import configparser
import fcntl
import hashlib
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

CONFIG = Path('/srv/app-services/supervisor')
LOCK = Path('/run/app-services/change.lock')
OWNER = 0
NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z')
SECTION = re.compile(r'^\s*\[([^]\r\n]+)\]')


class AppError(ValueError):
    """A reviewed message which never includes command/env contents."""


def read_config(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != OWNER or info.st_mode & 0o022:
            raise ValueError(f'配置须为 root 所有且不可被组或其他用户写入：{path.name}')
        if info.st_size > 1024 * 1024:
            raise ValueError('Supervisor 配置过大，未修改')
        data = source.read(1024 * 1024 + 1)
    if len(data) > 1024 * 1024:
        raise ValueError('Supervisor 配置过大，未修改')
    parser = configparser.ConfigParser(interpolation=None, inline_comment_prefixes=(';', '#'))
    parser.read_string(data.decode('utf-8'))
    return data, info, parser


def applications(directory=CONFIG):
    result = {}
    for path in sorted(directory.glob('*.conf')):
        data, info, parser = read_config(path)
        revision = hashlib.sha256(data).hexdigest()
        for section in parser.sections():
            if not section.startswith('program:'):
                continue
            name = section.removeprefix('program:')
            if not NAME.fullmatch(name) or name in ('sshd', 'nginx') or name in result:
                raise ValueError('应用名无效、与核心服务冲突或重复，未修改任何配置')
            enabled = parser.getboolean(section, 'autostart', fallback=True)
            result[name] = (enabled, revision, path, data, info)
    return result


def replace_autostart(data, name, enabled):
    lines = data.decode('utf-8').splitlines(keepends=True)
    start = end = option = option_indent = None
    # Match ConfigParser's continuation rules so an indented command argument
    # such as "autostart=true" or "[program:other]" is never edited as a key/section.
    for index, line in enumerate(lines):
        if not line.strip() or line.lstrip().startswith((';', '#')):
            continue
        indent = len(line) - len(line.lstrip())
        if option_indent is not None and indent > option_indent:
            continue
        match = SECTION.match(line)
        if match:
            if start is not None:
                end = index
                break
            if match[1] == f'program:{name}':
                start = index + 1
            option_indent = None
            continue
        key = re.match(r'^\s*([^=:]+?)\s*[=:]', line)
        if key:
            option_indent = indent
            if start is not None and key[1].strip().lower() == 'autostart':
                option = index
    if start is None:
        raise AppError('应用定义已变化，请重新打开菜单')
    end = len(lines) if end is None else end
    newline = '\r\n' if any(line.endswith('\r\n') for line in lines) else '\n'
    replacement = f'autostart={str(enabled).lower()}{newline}'
    if option is not None:
        indentation = re.match(r'^\s*', lines[option])[0]
        lines[option] = indentation + replacement
    else:
        if end and not lines[end - 1].endswith(('\n', '\r')):
            lines[end - 1] += newline
        lines.insert(end, replacement)
    return ''.join(lines).encode('utf-8')


def set_autostart(name, enabled, expected, directory=CONFIG):
    if not NAME.fullmatch(name) or not re.fullmatch('[0-9a-f]{64}', expected):
        raise AppError('应用名或配置版本无效')
    app = applications(directory).get(name)
    if app is None:
        raise AppError('找不到应用，请重新打开菜单')
    current, revision, path, data, info = app
    if revision != expected:
        raise AppError('配置已被其他操作者修改，请重新打开菜单')
    if current == enabled:
        return
    next_data = replace_autostart(data, name, enabled)
    fd, temporary = tempfile.mkstemp(prefix=f'.{path.name}.', dir=directory)
    try:
        with os.fdopen(fd, 'wb') as target:
            os.fchmod(target.fileno(), stat.S_IMODE(info.st_mode))
            os.fchown(target.fileno(), info.st_uid, info.st_gid)
            target.write(next_data)
            target.flush()
            os.fsync(target.fileno())
        if read_config(path)[0] != data:
            raise AppError('配置已变化，未覆盖，请重试')
        os.replace(temporary, path)
        directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main(args):
    if os.geteuid() != 0:
        raise AppError('此工具需要服务容器管理员权限')
    if args != ['list'] and not (len(args) == 4 and args[0] == 'set' and args[2] in ('true', 'false')):
        raise AppError('用法：deploy-apps list | set <应用名> <true|false> <配置版本>')
    # Shared with the documented deployment workflow; never lock business data.
    fd = os.open(LOCK, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX if args[0] == 'set' else fcntl.LOCK_SH)
        if args[0] == 'list':
            for name, (enabled, revision, *_rest) in applications().items():
                print(f'{name}\t{str(enabled).lower()}\t{revision}')
        else:
            set_autostart(args[1], args[2] == 'true', args[3])
            print(f'{args[1]}：自启动已设为 {args[2]}；下次服务启动生效，当前进程未启动、停止或重启。')


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except AppError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, configparser.Error):
        # Config parser exceptions can contain command/environment values. Never echo them.
        print('应用配置操作失败；请检查应用名、root 所有权、配置格式及是否已被他人修改，再重新打开菜单。未启动或重启应用。', file=sys.stderr)
        sys.exit(1)
