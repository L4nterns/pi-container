import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entrypoint = fileURLToPath(new URL('../docker-entrypoint.sh', import.meta.url));

test('rejects invalid UID/GID/groups before initialization or running a command', () => {
  const invalid = [
    { PUID: '' }, { PUID: '-1' }, { PUID: '1:2' }, { PGID: '' }, { PGID: '1:2' },
    { PI_GROUPS: '' }, { PI_GROUPS: '0,,1' }, { PI_GROUPS: ',1' }, { PI_GROUPS: '1,' }, { PI_GROUPS: 'abc' },
  ];
  for (const values of invalid) {
    const result = spawnSync('sh', [entrypoint, '--pi-docker-shell', '-c', 'echo should-not-run'], {
      encoding: 'utf8', env: { ...process.env, PUID: '1000', PGID: '1000', PI_GROUPS: '1000', ...values },
    });
    assert.equal(result.status, 1, JSON.stringify(values));
    assert.match(result.stderr, /不合法/);
    assert.equal(result.stdout, '');
  }
});
