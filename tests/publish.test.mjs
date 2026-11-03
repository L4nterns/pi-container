import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { publishSite } from '../skills/vibe-projects/scripts/publish.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-publish-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const output = path.join(root, 'sites');
  const source = path.join(workspace, 'build');
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(output);
  await fs.writeFile(path.join(source, 'index.html'), '<h1>new</h1>');
  const publish = (options = {}) => publishSite({
    slug: 'demo', source, workspaceRoot: workspace, publicRoot: output,
    publicUrl: 'https://example.com', ...options,
  });
  return { root, workspace, output, source, publish };
}

async function assertClean(output) {
  assert.deepEqual(await fs.readdir(path.join(output, '.publish-internal')), []);
}

test('publishes a complete snapshot, replaces the previous site and reports stats', async t => {
  const { source, output, publish } = await fixture(t);
  await fs.mkdir(path.join(source, 'assets'));
  await fs.writeFile(path.join(source, 'assets', 'app.js'), 'console.log("ok");');
  await fs.mkdir(path.join(output, 'demo'));
  await fs.writeFile(path.join(output, 'demo', 'old.txt'), 'old');
  const result = await publish();
  assert.equal(result.url, 'https://example.com/demo/');
  assert.equal(result.files, 2);
  assert.equal(result.bytes, Buffer.byteLength('<h1>new</h1>console.log("ok");'));
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(await fs.readdir(result.target), ['assets', 'index.html']);
  assert.equal((await fs.stat(result.target)).mode & 0o777, 0o755);
  assert.equal((await fs.stat(path.join(result.target, 'index.html'))).mode & 0o777, 0o644);
  await assertClean(output);
});

test('high-confidence credentials block before switching and are not echoed', async t => {
  const { source, output, publish } = await fixture(t);
  await fs.mkdir(path.join(output, 'demo'));
  await fs.writeFile(path.join(output, 'demo', 'index.html'), 'original');
  const secrets = [
    '-----BEGIN RSA PRIVATE KEY-----', `AKIA${'A'.repeat(16)}`,
    `ghp_${'a'.repeat(36)}`, `github_pat_${'a'.repeat(50)}`, `xoxb-${'a'.repeat(30)}`,
  ];
  for (const secret of secrets) {
    await fs.writeFile(path.join(source, 'app.js'), `const value = ${JSON.stringify(secret)};`);
    await assert.rejects(publish(), err => {
      assert.match(err.message, /中止发布/);
      assert.ok(!err.message.includes(secret));
      return true;
    });
    assert.equal(await fs.readFile(path.join(output, 'demo', 'index.html'), 'utf8'), 'original');
    await assertClean(output);
  }
});

test('large bundles and signatures crossing a stream boundary are scanned', async t => {
  const { source, publish } = await fixture(t);
  const prefix = ' '.repeat(10 * 1024 * 1024 + 65530);
  await fs.writeFile(path.join(source, 'app.js'), `${prefix}ghp_${'a'.repeat(36)}`);
  await assert.rejects(publish(), /GitHub/);
});

test('warns about suspicious fields and wrong paths, not correctly prefixed or external paths', async t => {
  const { source, publish } = await fixture(t);
  await fs.writeFile(path.join(source, 'index.html'), '<script src="/demo/app.js"></script><a href="//example.org/a">a</a><a href="https://example.org/">b</a>');
  await fs.writeFile(path.join(source, 'app.css'), 'a{background:url(/demo/bg.png)}');
  assert.deepEqual((await publish()).warnings, []);
  await fs.writeFile(path.join(source, 'index.html'), '<script src="/assets/app.js"></script>');
  await fs.writeFile(path.join(source, 'app.css'), 'a{background:url(/bg.png)}');
  await fs.writeFile(path.join(source, 'app.json'), JSON.stringify({ token: 'example-placeholder' }));
  const { warnings } = await publish();
  assert.equal(warnings.length, 3);
  assert.match(warnings.join('\n'), /HTML/);
  assert.match(warnings.join('\n'), /CSS/);
  assert.match(warnings.join('\n'), /疑似凭据/);
  assert.ok(!warnings.join('\n').includes('example-placeholder'));
});

test('rejects hidden files, source, dependency metadata and symlinks without altering old content', async t => {
  const { source, output, publish } = await fixture(t);
  await publish();
  for (const file of ['.env', 'source.ts', 'app.js.map', 'package.json', 'key.pem']) {
    await fs.writeFile(path.join(source, file), 'test');
    await assert.rejects(publish(), /禁止发布/);
    await fs.unlink(path.join(source, file));
    assert.equal(await fs.readFile(path.join(output, 'demo', 'index.html'), 'utf8'), '<h1>new</h1>');
    await assertClean(output);
  }
  await fs.symlink(path.join(source, 'index.html'), path.join(source, 'link.html'));
  await assert.rejects(publish(), /符号链接/);
  await assertClean(output);
});

test('requires nonempty index, a contained source, nonoverlapping roots and a real target', async t => {
  const { source, output, workspace, publish } = await fixture(t);
  await fs.writeFile(path.join(source, 'index.html'), '');
  await assert.rejects(publish(), /非空/);
  await fs.writeFile(path.join(source, 'index.html'), 'ok');
  await assert.rejects(publish({ source: output }), /必须位于/);
  await assert.rejects(publish({ publicRoot: workspace }), /不能相互包含/);
  await fs.symlink(source, path.join(output, 'demo'));
  await assert.rejects(publish(), /拒绝覆盖/);
  assert.ok((await fs.lstat(path.join(output, 'demo'))).isSymbolicLink());
  await assertClean(output);
});

test('a preexisting lock is preserved, and concurrent distinct slugs can publish', async t => {
  const { output, publish } = await fixture(t);
  const internal = path.join(output, '.publish-internal');
  await fs.mkdir(internal);
  const lock = path.join(internal, 'demo.publish.lock');
  await fs.writeFile(lock, 'existing');
  await assert.rejects(publish(), /残留锁/);
  assert.equal(await fs.readFile(lock, 'utf8'), 'existing');
  await fs.unlink(lock);
  const results = await Promise.all([publish(), publish({ slug: 'second' })]);
  assert.equal(results.length, 2);
  await assertClean(output);
});

test('a failed directory switch restores the old site and removes staged files', async t => {
  const { source, output, publish } = await fixture(t);
  await publish();
  await fs.writeFile(path.join(source, 'index.html'), 'replacement');
  const rename = fs.rename.bind(fs);
  let injected = false;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (path.basename(from).includes('.stage-')) {
      injected = true;
      throw Object.assign(new Error('injected switch failure'), { code: 'EIO' });
    }
    return rename(from, to);
  });
  await assert.rejects(publish(), /injected switch failure/);
  assert.ok(injected);
  assert.equal(await fs.readFile(path.join(output, 'demo', 'index.html'), 'utf8'), '<h1>new</h1>');
  await assertClean(output);
});

test('rejects a symlinked staging directory without modifying its destination', async t => {
  const { source, output, publish } = await fixture(t);
  await fs.symlink(source, path.join(output, '.publish-internal'));
  await assert.rejects(publish(), /暂存区必须是真实目录/);
  assert.deepEqual(await fs.readdir(source), ['index.html']);
});

test('validates identifiers and public URLs before changing files', async t => {
  const { publish, output } = await fixture(t);
  for (const slug of ['', '../escape', 'UPPER', '-demo', 'x'.repeat(64)]) {
    await assert.rejects(publish({ slug }), /slug/);
  }
  for (const publicUrl of ['', 'file:///tmp/', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?q=1']) {
    await assert.rejects(publish({ publicUrl }), /VIBE_PUBLIC_URL/);
  }
  assert.deepEqual(await fs.readdir(output), []);
});
