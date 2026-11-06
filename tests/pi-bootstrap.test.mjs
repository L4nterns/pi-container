import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access, mkdir } from 'node:fs/promises';
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
test('online bootstrap installs once, does not resurrect removed packages or mutate provider files',async t=>{
  const s=await setup(t);const source='git:github.com/example/independent-provider';
  await writeFile(s.manifest,JSON.stringify({packages:[{source}]}));
  const files={'settings.json':'{"packages":[]}','auth.json':'{"test":{"type":"api_key","key":"FAKE"}}','models.json':'{"providers":{}}'};
  for(const [name,value]of Object.entries(files))await writeFile(join(s.dir,name),value);
  assert.equal(s.run().status,0);assert.equal(s.run().status,0);
  assert.equal((await readFile(s.log,'utf8')).trim(),`install ${source}`);
  assert.deepEqual(JSON.parse(await readFile(join(s.dir,'.pic-packages.json'),'utf8')),{version:1,installed:[source]});
  for(const[name,value]of Object.entries(files))assert.equal(await readFile(join(s.dir,name),'utf8'),value);
});
test('an already configured same-name local package is preserved without duplicate install or migration',async t=>{
  const s=await setup(t),existing=join(s.dir,'user-package');await mkdir(existing);
  await writeFile(join(existing,'package.json'),'{"name":"independent-provider","version":"0.9.0"}');
  const settings=JSON.stringify({packages:[{source:existing,extensions:['src/index.ts']}]});
  await writeFile(join(s.dir,'settings.json'),settings);
  await writeFile(s.manifest,JSON.stringify({packages:[{source:'git:github.com/example/independent-provider',name:'independent-provider'}]}));
  assert.equal(s.run().status,0);await assert.rejects(access(s.log));
  assert.equal(await readFile(join(s.dir,'settings.json'),'utf8'),settings);
});
test('local package paths and malformed online sources fail before installation',async t=>{
  const s=await setup(t);
  for(const item of [
    {source:join(s.dir,'local-package')},
    {source:'./local-package'},
    {source:'git:'},
    {source:'git:invalid source'},
    {source:'--help'},
  ]){
    await writeFile(s.manifest,JSON.stringify({packages:[item]}));
    assert.notEqual(s.run().status,0);
    await assert.rejects(access(s.log));
    await assert.rejects(access(join(s.dir,'.pic-packages.json')));
  }
});
test('failed online installation is not marked complete; empty manifest opts out',async t=>{
  const s=await setup(t);await writeFile(s.manifest,JSON.stringify({packages:[{source:'npm:test'}]}));
  assert.notEqual(s.run({TEST_INSTALL_STATUS:'1'}).status,0);assert.equal(s.run().status,0);assert.equal((await readFile(s.log,'utf8')).trim().split('\n').length,2);
  await writeFile(s.manifest,'{"packages":[]}');assert.equal(s.run().status,0);
});
test('pic references the public plugin repository without bundling its implementation',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  const manifest=JSON.parse(await readFile(join(root,'config/pi-bootstrap.json'),'utf8'));
  assert.deepEqual(manifest.packages,[{source:'git:github.com/L4nterns/pi-provider-gateway',name:'pi-provider-gateway'}]);
  await assert.rejects(access(join(root,'packages')));
  const image=await readFile(join(root,'Dockerfile'),'utf8');
  assert.doesNotMatch(image,/COPY\s+packages\/|\/opt\/pic\/packages\/|pi-provider-gateway\/src/);
  await assert.rejects(access(join(root,'scripts/run-pi.sh')));
  await assert.rejects(access(join(root,'tests/package-updates.test.mjs')));
  for(const file of ['pic-entrypoint.sh','scripts/pic-session.sh','scripts/bootstrap-pi.mjs']){
    const text=await readFile(join(root,file),'utf8');
    assert.doesNotMatch(text,/run-pi\.sh|\.pic-packages\.lock|--prepared|--hosted|state\.pending|Updating Pi package/);
  }
  assert.match(await readFile(script,'utf8'),/\['install', item\.source\]/);
  assert.match(await readFile(join(root,'scripts/pic-session.sh'),'utf8'),/new-session[^\n]+-- pi /);
});
