import { strict as assert } from 'node:assert';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { executeFixedDockerBuild } from '../src/image-builder.js';

const runtime = `sha256:${'a'.repeat(64)}`;
const built = `sha256:${'b'.repeat(64)}`;
const other = `sha256:${'c'.repeat(64)}`;
const layer = `sha256:${'d'.repeat(64)}`;
const tag = 'codeharbor-repo:aaaaaaaaaaaaaaaaaaaa-53cae6f9-cb91-4f03-9615-ce744a6046cf';
const details = { id: runtime, os: 'linux', arch: 'amd64', layers: [layer], env: ['SAFE=1'], user: 'node', entrypoint: ['node'], cmd: ['serve'], workingDir: '/workspace/repo', volumes: null };
const dockerScript = `#!/usr/bin/env node
const fs=require('node:fs'), path=require('node:path'), dir=path.dirname(process.argv[1]);
const args=process.argv.slice(2); fs.appendFileSync(path.join(dir,'calls'),JSON.stringify(args)+'\\n');
const read=(name)=>fs.readFileSync(path.join(dir,name),'utf8');
const state=path.join(dir,'tag'); const base=JSON.parse(read('base.json'));
if(args[0]==='image' && args[1]==='inspect') {
  const ref=args[args.length-1];
  if(read('mode')==='sleep') { setTimeout(()=>process.exit(0),10000); return; }
  if(ref===base.id) { console.log(JSON.stringify(base)); return; }
  if(ref.startsWith('codeharbor-runtime:')) {
    if(!fs.existsSync(state)) { console.error('Error: No such image: '+ref); process.exit(1); }
    console.log(JSON.stringify({...base,id:read('tag').trim()})); return;
  }
  if(ref===read('built-id').trim()) { console.log(read('built.json')); return; }
  console.error('Error: No such image'); process.exit(1);
}
if(args[0]==='image' && args[1]==='tag') { fs.writeFileSync(state,args[2]); return; }
if(args[0]==='build') {
  fs.writeFileSync(args[args.indexOf('--iidfile')+1],read('built-id'));
  if(read('mode')==='retag') fs.writeFileSync(state,read('other-id'));
  return;
}
process.exit(1);
`;

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ch-build-platform-')); const bin = join(dir, 'docker');
  await writeFile(bin, dockerScript); await chmod(bin, 0o700);
  await writeFile(join(dir, 'base.json'), JSON.stringify(details));
  await writeFile(join(dir, 'built.json'), JSON.stringify({ ...details, id: built, layers: [layer, `sha256:${'e'.repeat(64)}`] }));
  await writeFile(join(dir, 'built-id'), built); await writeFile(join(dir, 'other-id'), other);
  await writeFile(join(dir, 'mode'), 'normal'); await writeFile(join(dir, 'Dockerfile'), `FROM ${runtime}\nCOPY repo /workspace/repo\n`);
  const previousPath = process.env.PATH; process.env.PATH = `${dir}:${previousPath ?? '/usr/bin:/bin'}`;
  return { dir, iidFile: join(dir, 'image.id'), restore: () => { process.env.PATH = previousPath; } };
}

test('fixed Docker build uses the runtime platform and checks image ancestry and settings', async () => {
  const f = await fixture();
  try {
    await executeFixedDockerBuild(f.dir, f.iidFile, tag, 10_000, runtime);
    const calls: string[][] = (await readFile(join(f.dir, 'calls'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const build = calls.find(call => call[0] === 'build');
    assert.ok(build);
    assert.deepEqual(build.slice(0, 5), ['build', '--platform', 'linux/amd64', '--network=none', '--pull=false']);
    assert.match(await readFile(join(f.dir, 'Dockerfile'), 'utf8'), /^FROM codeharbor-runtime:sha-a{64}\n/);
    assert.equal(await readFile(f.iidFile, 'utf8'), built);
  } finally { f.restore(); await rm(f.dir, { recursive: true, force: true }); }
});

test('uses arm64 when it is the platform of the pinned runtime', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, 'base.json'), JSON.stringify({ ...details, arch: 'arm64' }));
    await writeFile(join(f.dir, 'built.json'), JSON.stringify({ ...details, arch: 'arm64', id: built, layers: [layer] }));
    await executeFixedDockerBuild(f.dir, f.iidFile, tag, 10_000, runtime);
    const calls: string[][] = (await readFile(join(f.dir, 'calls'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls.find(call => call[0] === 'build')?.slice(0, 3), ['build', '--platform', 'linux/arm64']);
  } finally { f.restore(); await rm(f.dir, { recursive: true, force: true }); }
});

test('parallel builds can safely share the same managed runtime tag', async () => {
  const f = await fixture();
  try {
    const first = join(f.dir, 'first'); const second = join(f.dir, 'second');
    await mkdir(first); await mkdir(second);
    for (const context of [first, second]) await writeFile(join(context, 'Dockerfile'), `FROM ${runtime}\nCOPY repo /workspace/repo\n`);
    await Promise.all([first, second].map(context => executeFixedDockerBuild(context, join(context, 'image.id'), tag, 10_000, runtime)));
    assert.equal(await readFile(join(f.dir, 'tag'), 'utf8'), runtime);
    assert.equal(await readFile(join(first, 'image.id'), 'utf8'), built);
    assert.equal(await readFile(join(second, 'image.id'), 'utf8'), built);
  } finally { f.restore(); await rm(f.dir, { recursive: true, force: true }); }
});

test('refuses an existing managed tag that points at another image', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, 'tag'), other);
    await assert.rejects(executeFixedDockerBuild(f.dir, f.iidFile, tag, 10_000, runtime));
    assert.equal(await readFile(join(f.dir, 'tag'), 'utf8'), other);
    assert.ok(!(await readFile(join(f.dir, 'calls'), 'utf8')).split('\n').some(line => line.startsWith('["build"')));
  } finally { f.restore(); await rm(f.dir, { recursive: true, force: true }); }
});

test('fails closed on unsupported platform, changed tag, or changed image ancestry', async () => {
  for (const variant of ['platform', 'retag', 'layers', 'environment'] as const) {
    const f = await fixture();
    try {
      if (variant === 'platform') await writeFile(join(f.dir, 'base.json'), JSON.stringify({ ...details, arch: 's390x' }));
      if (variant === 'retag') await writeFile(join(f.dir, 'mode'), 'retag');
      if (variant === 'layers') await writeFile(join(f.dir, 'built.json'), JSON.stringify({ ...details, id: built, layers: [`sha256:${'e'.repeat(64)}`] }));
      if (variant === 'environment') await writeFile(join(f.dir, 'built.json'), JSON.stringify({ ...details, id: built, env: ['UNSAFE=1'] }));
      await assert.rejects(executeFixedDockerBuild(f.dir, f.iidFile, tag, 10_000, runtime));
    } finally { f.restore(); await rm(f.dir, { recursive: true, force: true }); }
  }
});

test('rejects a timed-out inspection without starting a build', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, 'mode'), 'sleep');
    await assert.rejects(executeFixedDockerBuild(f.dir, f.iidFile, tag, 150, runtime));
    assert.ok(!(await readFile(join(f.dir, 'calls'), 'utf8')).split('\n').some(line => line.startsWith('["build"')));
  } finally { f.restore(); await rm(f.dir, { recursive: true, force: true }); }
});

test('refuses runtime or repository images with automatic Docker volumes', async () => {
  for (const variant of ['runtime', 'built', 'invalid', 'missing'] as const) {
    const f = await fixture();
    try {
      const volume = { '/workspace/repo': {} };
      if (variant === 'runtime') await writeFile(join(f.dir, 'base.json'), JSON.stringify({ ...details, volumes: volume }));
      if (variant === 'built') await writeFile(join(f.dir, 'built.json'), JSON.stringify({ ...details, id: built, volumes: volume }));
      if (variant === 'invalid') await writeFile(join(f.dir, 'base.json'), JSON.stringify({ ...details, volumes: [] }));
      if (variant === 'missing') { const { volumes: _volumes, ...without } = details; await writeFile(join(f.dir, 'base.json'), JSON.stringify(without)); }
      await assert.rejects(executeFixedDockerBuild(f.dir, f.iidFile, tag, 10_000, runtime));
      const calls = await readFile(join(f.dir, 'calls'), 'utf8');
      if (variant !== 'built') assert.ok(!calls.split('\n').some(line => line.startsWith('["build"')));
    } finally { f.restore(); await rm(f.dir, { recursive: true, force: true }); }
  }
});

test('accepts an empty volume map from Docker image inspection', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, 'base.json'), JSON.stringify({ ...details, volumes: {} }));
    await writeFile(join(f.dir, 'built.json'), JSON.stringify({ ...details, id: built, volumes: {} }));
    await executeFixedDockerBuild(f.dir, f.iidFile, tag, 10_000, runtime);
  } finally { f.restore(); await rm(f.dir, { recursive: true, force: true }); }
});
