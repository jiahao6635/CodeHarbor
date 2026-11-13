import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DockerImageQueryBackend, dockerCreateArguments } from '../src/docker-image-query.js';
import { FileImageCreationFence } from '../src/image-creation-fence.js';
import { IMAGE_PROJECT_PATH, type ImageDigest } from '../src/image-codegraph.js';

const digest = `sha256:${'b'.repeat(64)}` as ImageDigest;
const identity = { repoId: 'repo_1', commit: 'd'.repeat(40) };
const owner = 'controller_1';

test('Docker arguments fix read-only isolation and reject injected image identifiers', () => {
  const name = `codeharbor-query-${randomUUID()}`;
  const args = dockerCreateArguments(digest, name, owner);
  for (const arg of ['--rm', '--read-only', '--network', 'none', '--user', '1000:1000', '--cap-drop', 'ALL', '--pids-limit']) assert.ok(args.includes(arg));
  assert.ok(args.includes('io.codeharbor.image-query-owner=controller_1'));
  assert.ok(args.includes('io.codeharbor.image-query-kind=readonly'));
  for (const arg of ['--volume', '-v', '--mount', '--privileged']) assert.ok(!args.includes(arg));
  assert.equal(args[args.indexOf('--entrypoint') + 1], '/usr/local/bin/node');
  assert.throws(() => dockerCreateArguments(`${digest};touch /tmp/untrusted`, name, owner));
  assert.throws(() => dockerCreateArguments(digest, `${name} --privileged`, owner));
  assert.throws(() => dockerCreateArguments(digest, name, 'x --privileged'));
});

test('a timed out create kills the CLI and fails closed if daemon outcome is uncertain', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codeharbor-docker-query-test-'));
  try {
    const executable = join(dir, 'docker'); const log = join(dir, 'pid');
    await writeFile(executable, `#!/usr/bin/env node\nconst fs = require('node:fs');\nif (process.argv[2] === 'ps') process.exit(0); else if (process.argv[2] === 'create') { fs.writeFileSync(${JSON.stringify(log)}, String(process.pid)); setInterval(() => {}, 1000); } else if (process.argv[2] === 'inspect') { process.stderr.write('Error response from daemon: No such container: '+process.argv.at(-1)); process.exit(1); } else process.exit(1);\n`);
    await chmod(executable, 0o700);
    const fence = new FileImageCreationFence(dir, owner);
    const backend = new DockerImageQueryBackend(async () => true, executable, 3000, owner, fence);
    const controller = new AbortController();
    const request = backend.explore({ digest, ...identity, query: 'symbol', projectPath: IMAGE_PROJECT_PATH, readOnlyRoot: true, signal: controller.signal });
    let started = false;
    for (let i = 0; i < 100 && !started; i++) {
      try { await readFile(log, 'utf8'); started = true; }
      catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    assert.equal(started, true);
    setTimeout(() => controller.abort(), 25);
    await assert.rejects(request, /creation outcome is uncertain/);
    const pid = Number(await readFile(log, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    await assert.rejects(fence.assertClear(), /operator intervention/);
    await assert.rejects(backend.close(), /operator intervention/);
    await assert.rejects(backend.explore({ digest, ...identity, query: 'symbol', projectPath: IMAGE_PROJECT_PATH, readOnlyRoot: true, signal: new AbortController().signal }));
    const restarted = new DockerImageQueryBackend(async () => true, executable, 3000, owner, new FileImageCreationFence(dir, owner));
    await assert.rejects(restarted.probe(new AbortController().signal), /operator intervention/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cancellation while writing the fence clears it before any Docker create', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codeharbor-cancel-fence-'));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  try {
    const executable = join(dir, 'docker'); const log = join(dir, 'commands');
    await writeFile(executable, `#!/usr/bin/env node\nconst fs=require('node:fs'); const cmd=process.argv[2]; fs.appendFileSync(${JSON.stringify(log)},cmd+'\\n');\nif(cmd==='ps') process.exit(0); else if(cmd==='version') console.log('1.0'); else if(cmd==='inspect') {process.stderr.write('Error response from daemon: No such container: '+process.argv.at(-1)); process.exit(1)} else process.exit(1);\n`);
    await chmod(executable, 0o700);
    const fence = new FileImageCreationFence(dir, owner);
    const waitingFence = {
      assertClear: () => fence.assertClear(),
      begin: async (name: string) => { await fence.begin(name); entered(); await gate; },
      complete: (name: string) => fence.complete(name),
    };
    const backend = new DockerImageQueryBackend(async () => true, executable, 3000, owner, waitingFence);
    const controller = new AbortController();
    const request = backend.explore({ digest, ...identity, query: 'symbol', projectPath: IMAGE_PROJECT_PATH, readOnlyRoot: true, signal: controller.signal });
    await began;
    controller.abort(); release();
    await assert.rejects(request, /Image runtime request failed/);
    await fence.assertClear();
    assert.ok(!(await readFile(log, 'utf8')).split('\n').includes('create'));
    await backend.probe(new AbortController().signal);
    await backend.close();
  } finally { release(); await rm(dir, { recursive: true, force: true }); }
});

test('a nonzero docker create preserves its fence because daemon outcome is unknown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codeharbor-docker-query-test-'));
  try {
    const executable = join(dir, 'docker');
    await writeFile(executable, `#!/usr/bin/env node\nif(process.argv[2]==='ps') process.exit(0); else if(process.argv[2]==='create') process.exit(1); else if(process.argv[2]==='inspect') { process.stderr.write('Error response from daemon: No such container: '+process.argv.at(-1)); process.exit(1); } else process.exit(1);\n`);
    await chmod(executable, 0o700);
    const fence = new FileImageCreationFence(dir, owner);
    const runtime = new DockerImageQueryBackend(async () => true, executable, 3000, owner, fence);
    await assert.rejects(runtime.explore({ digest, ...identity, query: 'symbol', projectPath: IMAGE_PROJECT_PATH, readOnlyRoot: true, signal: new AbortController().signal }), /outcome is uncertain/);
    await assert.rejects(fence.assertClear(), /operator intervention/);
    await assert.rejects(new DockerImageQueryBackend(async () => true, executable, 3000, owner, new FileImageCreationFence(dir, owner)).probe(new AbortController().signal), /operator intervention/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the trusted control plane must authorize the image before Docker is invoked', async () => {
  const backend = new DockerImageQueryBackend(async () => false, '/definitely/not/docker', 30000, owner);
  await assert.rejects(backend.explore({ digest, ...identity, query: 'symbol', projectPath: IMAGE_PROJECT_PATH, readOnlyRoot: true, signal: new AbortController().signal }), /unavailable/);
});

test('startup recovery removes only containers with matching owner, kind and name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codeharbor-docker-recovery-'));
  const id = 'e'.repeat(64); const name = `codeharbor-query-${randomUUID()}`;
  const script = join(dir, 'docker'); const removed = join(dir, 'removed');
  try {
    const labels = { 'io.codeharbor.image-query-owner': owner, 'io.codeharbor.image-query-kind': 'readonly' };
    await writeFile(script, `#!/usr/bin/env node\nconst fs=require('node:fs'); const cmd=process.argv[2];\nif(cmd==='ps') console.log(${JSON.stringify(id)}); else if(cmd==='inspect') { if(fs.existsSync(${JSON.stringify(removed)})) { process.stderr.write('Error response from daemon: No such container: '+process.argv.at(-1)); process.exit(1); } else if(process.argv.includes('{{.Id}}|{{.Name}}|{{json .Config.Labels}}')) console.log(${JSON.stringify(id + '|/' + name + '|' + JSON.stringify(labels))}); else console.log(${JSON.stringify('/' + name + '|' + JSON.stringify(labels))}); } else if(cmd==='rm') { fs.appendFileSync(${JSON.stringify(removed)},process.argv.at(-1)+'\\n'); process.stderr.write('removal already in progress'); process.exit(1); } else if(cmd==='version') console.log('1.0'); else process.exit(1);\n`);
    await chmod(script, 0o700);
    const runtime = new DockerImageQueryBackend(async () => true, script, 3000, owner);
    await runtime.probe(new AbortController().signal);
    assert.equal((await readFile(removed, 'utf8')).trim(), id);
    await runtime.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('startup recovery refuses to remove containers whose owner label does not match', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codeharbor-docker-recovery-'));
  const id = 'f'.repeat(64); const name = `codeharbor-query-${randomUUID()}`;
  const script = join(dir, 'docker'); const removed = join(dir, 'removed');
  try {
    const labels = { 'io.codeharbor.image-query-owner': 'someone_else', 'io.codeharbor.image-query-kind': 'readonly' };
    await writeFile(script, `#!/usr/bin/env node\nconst fs=require('node:fs'); const cmd=process.argv[2];\nif(cmd==='ps') console.log(${JSON.stringify(id)}); else if(cmd==='inspect') console.log(${JSON.stringify('/' + name + '|' + JSON.stringify(labels))}); else if(cmd==='rm') fs.writeFileSync(${JSON.stringify(removed)},'deleted'); else process.exit(1);\n`);
    await chmod(script, 0o700);
    const runtime = new DockerImageQueryBackend(async () => true, script, 3000, owner);
    await assert.rejects(runtime.probe(new AbortController().signal), /operator intervention/);
    await assert.rejects(readFile(removed), { code: 'ENOENT' });
    await assert.rejects(runtime.probe(new AbortController().signal), /operator intervention/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cleanup fails closed when rm succeeds but the container still exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codeharbor-docker-recovery-'));
  const id = 'a'.repeat(64); const name = `codeharbor-query-${randomUUID()}`;
  const script = join(dir, 'docker'); const removed = join(dir, 'removed');
  try {
    const labels = { 'io.codeharbor.image-query-owner': owner, 'io.codeharbor.image-query-kind': 'readonly' };
    await writeFile(script, `#!/usr/bin/env node\nconst fs=require('node:fs'); const cmd=process.argv[2];\nif(cmd==='ps') console.log(${JSON.stringify(id)}); else if(cmd==='inspect') { if(process.argv.includes('{{.Id}}|{{.Name}}|{{json .Config.Labels}}')) console.log(${JSON.stringify(id + '|/' + name + '|' + JSON.stringify(labels))}); else console.log(${JSON.stringify('/' + name + '|' + JSON.stringify(labels))}); } else if(cmd==='rm') fs.writeFileSync(${JSON.stringify(removed)},process.argv.at(-1)); else process.exit(1);\n`);
    await chmod(script, 0o700);
    const runtime = new DockerImageQueryBackend(async () => true, script, 800, owner);
    await assert.rejects(runtime.probe(new AbortController().signal), /operator intervention/);
    assert.equal(await readFile(removed, 'utf8'), id);
    await assert.rejects(runtime.probe(new AbortController().signal), /operator intervention/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function runEffectiveConfigTest(scenario: 'safe' | 'wrong-image' | 'writable' | 'network' | 'volume' | 'malformed'): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'codeharbor-docker-config-'));
  const id = 'e'.repeat(64); const script = join(dir, 'docker');
  const nameFile = join(dir, 'name'); const removed = join(dir, 'removed'); const started = join(dir, 'started');
  try {
    const labels = { 'io.codeharbor.image-query-owner': owner, 'io.codeharbor.image-query-kind': 'readonly' };
    const config = scenario === 'malformed' ? 'invalid-json' : [
      JSON.stringify(scenario === 'wrong-image' ? `sha256:${'f'.repeat(64)}` : digest),
      JSON.stringify(scenario !== 'writable'), JSON.stringify(scenario === 'network' ? 'bridge' : 'none'),
      JSON.stringify(scenario === 'volume' ? [{ Type: 'volume', Destination: '/workspace/repo' }] : []),
    ].join('|');
    await writeFile(script, `#!/usr/bin/env node\nconst fs=require('node:fs'); const cmd=process.argv[2];\nif(cmd==='ps') process.exit(0);\nelse if(cmd==='create') { fs.writeFileSync(${JSON.stringify(nameFile)},process.argv[process.argv.indexOf('--name')+1]); console.log(${JSON.stringify(id)}); }\nelse if(cmd==='inspect') { if(fs.existsSync(${JSON.stringify(removed)})) { process.stderr.write('Error response from daemon: No such container: '+process.argv.at(-1)); process.exit(1); } else if(process.argv.includes('{{json .Image}}|{{json .HostConfig.ReadonlyRootfs}}|{{json .HostConfig.NetworkMode}}|{{json .Mounts}}')) console.log(${JSON.stringify(config)}); else console.log(${JSON.stringify(id + '|/')}+fs.readFileSync(${JSON.stringify(nameFile)},'utf8')+${JSON.stringify('|' + JSON.stringify(labels))}); }\nelse if(cmd==='rm') fs.writeFileSync(${JSON.stringify(removed)},process.argv.at(-1));\nelse if(cmd==='start') { fs.writeFileSync(${JSON.stringify(started)},'yes'); const rl=require('node:readline').createInterface({input:process.stdin}); rl.on('line',line=>{const req=JSON.parse(line);if(req.id===undefined)return;let result;if(req.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}};else if(req.method==='tools/list')result={tools:[{name:'codegraph_explore',inputSchema:{type:'object',properties:{query:{type:'string'},projectPath:{type:'string'}}}}]};else if(req.method==='tools/call')result={content:[{type:'text',text:'found'}]};else return;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n')}); } else process.exit(1);\n`);
    await chmod(script, 0o700);
    const fence = new FileImageCreationFence(dir, owner);
    const runtime = new DockerImageQueryBackend(async (d, r, c) => d === digest && r === identity.repoId && c === identity.commit, script, 5000, owner, fence);
    const request = runtime.explore({ digest, ...identity, query: 'symbol', projectPath: IMAGE_PROJECT_PATH, readOnlyRoot: true, signal: AbortSignal.timeout(5000) });
    if (scenario === 'safe') {
      assert.equal(await request, 'found');
      assert.equal(await readFile(started, 'utf8'), 'yes');
    } else {
      await assert.rejects(request);
      await assert.rejects(readFile(started), { code: 'ENOENT' });
    }
    assert.equal(await readFile(removed, 'utf8'), id);
    await fence.assertClear();
    await runtime.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('effective container inspection allows only the pinned no-mount read-only image', async () => {
  await runEffectiveConfigTest('safe');
  for (const scenario of ['wrong-image', 'writable', 'network', 'volume', 'malformed'] as const) await runEffectiveConfigTest(scenario);
});
