import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('../scripts/bootstrap-pi.mjs', import.meta.url));
async function setup(t) {
  const dir=await mkdtemp(join(tmpdir(),'pic-package-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const manifest=join(dir,'manifest.json');const log=join(dir,'install.log');const fake=join(dir,'pi');
  await writeFile(fake, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_INSTALL_LOG"\nexit "${TEST_INSTALL_STATUS:-0}"\n', {mode:0o700});
  return {dir,manifest,log,run:(extra={})=>spawnSync(process.execPath,[script],{encoding:'utf8',env:{...process.env,PI_CODING_AGENT_DIR:dir,PIC_PI_BOOTSTRAP_MANIFEST:manifest,PIC_PI_BINARY:fake,TEST_INSTALL_LOG:log,...extra}})};
}
test('generic bootstrap installs once, does not resurrect removed packages or mutate provider files',async t=>{
  const s=await setup(t);await writeFile(s.manifest,JSON.stringify({packages:[{source:'npm:test-gateway@1.0.0',version:'1.0.0'}]}));
  const files={'settings.json':'{"packages":[]}','auth.json':'{"test":{"type":"api_key","key":"FAKE"}}','models.json':'{"providers":{}}'};
  for(const [name,value]of Object.entries(files))await writeFile(join(s.dir,name),value);
  assert.equal(s.run().status,0);assert.equal(s.run().status,0);
  assert.equal((await readFile(s.log,'utf8')).trim(),'install npm:test-gateway@1.0.0');
  for(const[name,value]of Object.entries(files))assert.equal(await readFile(join(s.dir,name),'utf8'),value);
});
test('an already configured same-name independent package is not installed again',async t=>{
  const s=await setup(t);const bundled=join(s.dir,'bundled'),existing=join(s.dir,'pinned');await mkdir(bundled);await mkdir(existing);
  for(const path of[bundled,existing])await writeFile(join(path,'package.json'),'{"name":"independent-provider","version":"1.0.0"}');
  await writeFile(join(s.dir,'settings.json'),JSON.stringify({packages:[existing]}));await writeFile(s.manifest,JSON.stringify({packages:[{source:bundled,version:'1.0.0'}]}));
  assert.equal(s.run().status,0);await assert.rejects(readFile(s.log));assert.deepEqual(JSON.parse(await readFile(join(s.dir,'settings.json'),'utf8')).packages,[existing]);
});
test('failure is not marked complete; empty manifest opts out; version mismatch fails closed',async t=>{
  const s=await setup(t);await writeFile(s.manifest,JSON.stringify({packages:[{source:'npm:test@1',version:'1'}]}));
  assert.notEqual(s.run({TEST_INSTALL_STATUS:'1'}).status,0);assert.equal(s.run().status,0);assert.equal((await readFile(s.log,'utf8')).trim().split('\n').length,2);
  await writeFile(s.manifest,'{"packages":[]}');assert.equal(s.run().status,0);
  await writeFile(join(s.dir,'package.json'),'{"version":"2"}');await writeFile(s.manifest,JSON.stringify({packages:[{source:s.dir,version:'1'}]}));assert.notEqual(s.run().status,0);
});
