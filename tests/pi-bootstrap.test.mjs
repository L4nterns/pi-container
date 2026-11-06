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
  const s=await setup(t);const ref='a'.repeat(40),source=`git:github.com/example/independent-provider@${ref}`;
  await writeFile(s.manifest,JSON.stringify({packages:[{source,version:ref}]}));
  const files={'settings.json':'{"packages":[]}','auth.json':'{"test":{"type":"api_key","key":"FAKE"}}','models.json':'{"providers":{}}'};
  for(const [name,value]of Object.entries(files))await writeFile(join(s.dir,name),value);
  assert.equal(s.run().status,0);assert.equal(s.run().status,0);
  assert.equal((await readFile(s.log,'utf8')).trim(),`install ${source}`);
  for(const[name,value]of Object.entries(files))assert.equal(await readFile(join(s.dir,name),'utf8'),value);
});
test('an already configured same-name local package is preserved without duplicate install or migration',async t=>{
  const s=await setup(t),existing=join(s.dir,'user-package');await mkdir(existing);
  await writeFile(join(existing,'package.json'),'{"name":"independent-provider","version":"0.9.0"}');
  const settings=JSON.stringify({packages:[{source:existing,extensions:['src/index.ts']}]});
  await writeFile(join(s.dir,'settings.json'),settings);
  await writeFile(s.manifest,JSON.stringify({packages:[{source:'git:github.com/example/independent-provider@reviewed',version:'reviewed',name:'independent-provider'}]}));
  assert.equal(s.run().status,0);await assert.rejects(access(s.log));
  assert.equal(await readFile(join(s.dir,'settings.json'),'utf8'),settings);
});
test('local package paths and unpinned or mismatched online sources fail before installation',async t=>{
  const s=await setup(t);
  for(const item of [
    {source:join(s.dir,'local-package'),version:'1.0.0'},
    {source:'./local-package',version:'1.0.0'},
    {source:'git:github.com/example/independent-provider',version:'main'},
    {source:'npm:independent-provider@1.0.0',version:'2.0.0'},
    {source:'--help',version:'1.0.0'},
  ]){
    await writeFile(s.manifest,JSON.stringify({packages:[item]}));
    assert.notEqual(s.run().status,0);
    await assert.rejects(access(s.log));
    await assert.rejects(access(join(s.dir,'.pic-packages.json')));
  }
});
test('failed online installation is not marked complete; empty manifest opts out',async t=>{
  const s=await setup(t);await writeFile(s.manifest,JSON.stringify({packages:[{source:'npm:test@1',version:'1'}]}));
  assert.notEqual(s.run({TEST_INSTALL_STATUS:'1'}).status,0);assert.equal(s.run().status,0);assert.equal((await readFile(s.log,'utf8')).trim().split('\n').length,2);
  await writeFile(s.manifest,'{"packages":[]}');assert.equal(s.run().status,0);
});
test('pic references the public plugin repository without bundling its implementation',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  const manifest=JSON.parse(await readFile(join(root,'config/pi-bootstrap.json'),'utf8'));
  assert.equal(manifest.packages.length,1);
  const item=manifest.packages[0];
  assert.match(item.source,/^git:github\.com\/L4nterns\/pi-provider-gateway@[0-9a-f]{40}$/);
  assert.equal(item.version,item.source.split('@').at(-1));
  assert.equal(item.name,'pi-provider-gateway');
  await assert.rejects(access(join(root,'packages')));
  const image=await readFile(join(root,'Dockerfile'),'utf8');
  assert.doesNotMatch(image,/COPY\s+packages\/|\/opt\/pic\/packages\/|pi-provider-gateway\/src/);
});
