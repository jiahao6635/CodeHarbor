import { strict as assert } from 'node:assert';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { executeFixedDockerBuild, removeOwnedRepositoryImage } from '../src/image-builder.js';

const runtime = `sha256:${'a'.repeat(64)}`;
const built = `sha256:${'b'.repeat(64)}`;
const other = `sha256:${'c'.repeat(64)}`;
const layer = `sha256:${'d'.repeat(64)}`;
const containerId = 'f'.repeat(64);
const tag = 'codeharbor-repo:aaaaaaaaaaaaaaaaaaaa-53cae6f9-cb91-4f03-9615-ce744a6046cf';
const repositoryId = 'repo-1';
const commit = 'f'.repeat(40);
const dockerfile = [
  `FROM ${runtime}`,
  'COPY --chown=1000:1000 repo /workspace/repo',
  `LABEL io.codeharbor.repository-id="${repositoryId}"`,
  `LABEL io.codeharbor.commit="${commit}"`,
  'LABEL io.codeharbor.codegraph-version="1.6.2"',
  '',
].join('\n');
const details = {
  id: runtime,
  os: 'linux',
  arch: 'amd64',
  layers: [layer],
  env: ['SAFE=1'],
  user: 'node',
  entrypoint: ['node'],
  cmd: ['serve'],
  workingDir: '/workspace/repo',
  volumes: null,
};
const builtDetails = (overrides: Record<string, unknown> = {}) => ({
  ...details,
  id: built,
  layers: [layer, `sha256:${'e'.repeat(64)}`],
  labels: {
    'io.codeharbor.repository-id': repositoryId,
    'io.codeharbor.commit': commit,
    'io.codeharbor.codegraph-version': '1.6.2',
  },
  repoTags: [],
  size: 1024,
  ...overrides,
});
const dockerScript = `#!/usr/bin/env node
const fs=require('node:fs'), path=require('node:path'), dir=path.dirname(process.argv[1]);
const args=process.argv.slice(2); fs.appendFileSync(path.join(dir,'calls'),JSON.stringify(args)+'\\n');
const read=(name)=>fs.readFileSync(path.join(dir,name),'utf8');
const base=JSON.parse(read('base.json'));
if(args[0]==='image' && args[1]==='inspect') {
  const ref=args[args.length-1];
  if(read('mode')==='sleep') { setTimeout(()=>process.exit(0),10000); return; }
  if(ref===base.id) { console.log(JSON.stringify(base)); return; }
  if(ref===read('built-id').trim()) {
    if(fs.existsSync(path.join(dir,'removed'))) { console.error('Error: No such image: '+ref); process.exit(1); }
    console.log(read('built.json')); return;
  }
  console.error('Error: No such image'); process.exit(1);
}
if(args[0]==='image' && args[1]==='rm' && args[2]===read('built-id').trim()) {
  fs.writeFileSync(path.join(dir,'removed'),'1'); return;
}
if(args[0]==='container' && args[1]==='create') { console.log('${containerId}'); return; }
if(args[0]==='container' && args[1]==='cp') { return; }
if(args[0]==='container' && args[1]==='commit') {
  if(read('mode')==='runtime-change') fs.writeFileSync(path.join(dir,'base.json'),JSON.stringify({...base,id:read('other-id').trim()}));
  console.log(read('built-id').trim()); return;
}
if(args[0]==='container' && args[1]==='rm') { return; }
process.exit(1);
`;

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ch-build-platform-'));
  const bin = join(dir, 'docker');
  await writeFile(bin, dockerScript);
  await chmod(bin, 0o700);
  await writeFile(join(dir, 'base.json'), JSON.stringify(details));
  await writeFile(
    join(dir, 'built.json'),
    JSON.stringify(builtDetails()),
  );
  await writeFile(join(dir, 'built-id'), built);
  await writeFile(join(dir, 'other-id'), other);
  await writeFile(join(dir, 'mode'), 'normal');
  await writeFile(join(dir, 'Dockerfile'), dockerfile);
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}:${previousPath ?? '/usr/bin:/bin'}`;
  return {
    dir,
    iidFile: join(dir, 'image.id'),
    restore: () => {
      process.env.PATH = previousPath;
    },
  };
}

test('fixed image packaging avoids Docker build cache and checks image ancestry and settings', async () => {
  const f = await fixture();
  try {
    await executeFixedDockerBuild(f.dir, f.iidFile, tag, 10_000, runtime);
    const calls: string[][] = (await readFile(join(f.dir, 'calls'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(calls.some((call) => call[0] === 'build'), false);
    const create = calls.find((call) => call[0] === 'container' && call[1] === 'create');
    assert.ok(create?.includes('--network'));
    assert.equal(create?.at(-1), runtime);
    assert.ok(calls.some((call) => call[0] === 'container' && call[1] === 'cp'));
    const commitCall = calls.find((call) => call[0] === 'container' && call[1] === 'commit');
    assert.ok(commitCall?.includes(`LABEL io.codeharbor.repository-id="${repositoryId}"`));
    assert.ok(calls.some((call) => call.join(' ') === `container rm ${containerId}`));
    assert.equal(await readFile(join(f.dir, 'Dockerfile'), 'utf8'), dockerfile);
    assert.equal(await readFile(f.iidFile, 'utf8'), built);
  } finally {
    f.restore();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('owned image cleanup verifies labels before deleting the exact immutable ID', async () => {
  const f = await fixture();
  try {
    await removeOwnedRepositoryImage({ imageId: built, repositoryId, commit }, f.dir, 10_000);
    const calls: string[][] = (await readFile(join(f.dir, 'calls'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(calls.some((call) => call.join(' ') === `image rm ${built}`));

    await rm(join(f.dir, 'removed'));
    const unsafe = JSON.parse(await readFile(join(f.dir, 'built.json'), 'utf8'));
    unsafe.labels['io.codeharbor.repository-id'] = 'other';
    await writeFile(join(f.dir, 'built.json'), JSON.stringify(unsafe));
    await assert.rejects(removeOwnedRepositoryImage({ imageId: built, repositoryId, commit }, f.dir, 10_000));
    const after: string[][] = (await readFile(join(f.dir, 'calls'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(after.filter((call) => call[0] === 'image' && call[1] === 'rm').length, 1);
  } finally {
    f.restore();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('uses arm64 when it is the platform of the pinned runtime', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, 'base.json'), JSON.stringify({ ...details, arch: 'arm64' }));
    await writeFile(
      join(f.dir, 'built.json'),
      JSON.stringify(builtDetails({ arch: 'arm64', layers: [layer, `sha256:${'e'.repeat(64)}`] })),
    );
    await executeFixedDockerBuild(f.dir, f.iidFile, tag, 10_000, runtime);
    assert.equal(await readFile(f.iidFile, 'utf8'), built);
  } finally {
    f.restore();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('parallel packaging uses distinct temporary container names', async () => {
  const f = await fixture();
  try {
    const first = join(f.dir, 'first');
    const second = join(f.dir, 'second');
    await mkdir(first);
    await mkdir(second);
    for (const context of [first, second]) await writeFile(join(context, 'Dockerfile'), dockerfile);
    await Promise.all(
      [first, second].map((context) =>
        executeFixedDockerBuild(context, join(context, 'image.id'), tag, 10_000, runtime),
      ),
    );
    const calls: string[][] = (await readFile(join(f.dir, 'calls'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const names = calls
      .filter((call) => call[0] === 'container' && call[1] === 'create')
      .map((call) => call[call.indexOf('--name') + 1]);
    assert.equal(new Set(names).size, 2);
    assert.equal(await readFile(join(first, 'image.id'), 'utf8'), built);
    assert.equal(await readFile(join(second, 'image.id'), 'utf8'), built);
  } finally {
    f.restore();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('refuses packaging instructions without platform-authored identity labels', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, 'Dockerfile'), `FROM ${runtime}\nCOPY --chown=1000:1000 repo /workspace/repo\n`);
    await assert.rejects(executeFixedDockerBuild(f.dir, f.iidFile, tag, 10_000, runtime));
    assert.ok(
      !(await readFile(join(f.dir, 'calls'), 'utf8'))
        .split('\n')
        .some((line) => line.startsWith('["container","create"')),
    );
  } finally {
    f.restore();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('fails closed on unsupported platform, changed runtime, or changed image ancestry', async () => {
  for (const variant of ['platform', 'runtime', 'layers', 'environment'] as const) {
    const f = await fixture();
    try {
      if (variant === 'platform')
        await writeFile(join(f.dir, 'base.json'), JSON.stringify({ ...details, arch: 's390x' }));
      if (variant === 'runtime') await writeFile(join(f.dir, 'mode'), 'runtime-change');
      if (variant === 'layers')
        await writeFile(
          join(f.dir, 'built.json'),
          JSON.stringify(builtDetails({ layers: [`sha256:${'e'.repeat(64)}`] })),
        );
      if (variant === 'environment')
        await writeFile(join(f.dir, 'built.json'), JSON.stringify(builtDetails({ env: ['UNSAFE=1'] })));
      await assert.rejects(executeFixedDockerBuild(f.dir, f.iidFile, tag, 10_000, runtime));
    } finally {
      f.restore();
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});

test('rejects a timed-out inspection without starting a build', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, 'mode'), 'sleep');
    await assert.rejects(executeFixedDockerBuild(f.dir, f.iidFile, tag, 150, runtime));
    assert.ok(
      !(await readFile(join(f.dir, 'calls'), 'utf8'))
        .split('\n')
        .some((line) => line.startsWith('["container","create"')),
    );
  } finally {
    f.restore();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('refuses runtime or repository images with automatic Docker volumes', async () => {
  for (const variant of ['runtime', 'built', 'invalid', 'missing'] as const) {
    const f = await fixture();
    try {
      const volume = { '/workspace/repo': {} };
      if (variant === 'runtime')
        await writeFile(join(f.dir, 'base.json'), JSON.stringify({ ...details, volumes: volume }));
      if (variant === 'built')
        await writeFile(join(f.dir, 'built.json'), JSON.stringify(builtDetails({ volumes: volume })));
      if (variant === 'invalid') await writeFile(join(f.dir, 'base.json'), JSON.stringify({ ...details, volumes: [] }));
      if (variant === 'missing') {
        const { volumes: _volumes, ...without } = details;
        await writeFile(join(f.dir, 'base.json'), JSON.stringify(without));
      }
      await assert.rejects(executeFixedDockerBuild(f.dir, f.iidFile, tag, 10_000, runtime));
      const calls = await readFile(join(f.dir, 'calls'), 'utf8');
      if (variant !== 'built')
        assert.ok(!calls.split('\n').some((line) => line.startsWith('["container","create"')));
    } finally {
      f.restore();
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});

test('accepts an empty volume map from Docker image inspection', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, 'base.json'), JSON.stringify({ ...details, volumes: {} }));
    await writeFile(join(f.dir, 'built.json'), JSON.stringify(builtDetails({ volumes: {} })));
    await executeFixedDockerBuild(f.dir, f.iidFile, tag, 10_000, runtime);
  } finally {
    f.restore();
    await rm(f.dir, { recursive: true, force: true });
  }
});
