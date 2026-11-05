#!/usr/bin/python3
"""Enroll an installation key through host docker exec, not a network API."""
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def main():
    if os.geteuid() != 0 or len(sys.argv) != 2:
        sys.exit('Usage (root): deploy-register <ed25519-public-key>')
    key = sys.argv[1]
    if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/]{40,100}={0,2}(?: [^\r\n]*)?', key):
        sys.exit('Invalid SSH public key')
    root = Path('/srv/app-services')
    public_key = ' '.join(key.split(' ')[:2]) + '\n'
    fd, name = tempfile.mkstemp(dir=root / 'control', prefix='.keys-')
    try:
        with os.fdopen(fd, 'w') as output:
            output.write(public_key)
            # sshd reads authorized keys as the target user; this is public data.
            os.fchmod(output.fileno(), 0o644)
            output.flush()
            os.fsync(output.fileno())
        subprocess.run(['ssh-keygen', '-l', '-f', name], check=True, stdout=subprocess.DEVNULL)
        os.replace(name, root / 'control/authorized_keys')
        directory = os.open(root / 'control', os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)
    print(' '.join((root / 'ssh/ssh_host_ed25519_key.pub').read_text().split()[:2]))


if __name__ == '__main__':
    main()
