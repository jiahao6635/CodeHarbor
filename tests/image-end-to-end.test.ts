import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DockerImageQueryBackend } from '../src/docker-image-query.js';
import { getTrustedImage, SocketImageBuildExecutor, serveImageBuilder } from '../src/image-build-socket.js';
import { buildRepositoryImage, RepositoryImageError } from '../src/image-builder.js';
import { ImageCodeGraphClient, parseImageReference } from '../src/image-codegraph.js';
import { FileImageCreationFence } from '../src/image-creation-fence.js';
import { ImageIndexPipeline } from '../src/image-indexer.js';
import { SocketImageQueryBackend, serveImageRuntime } from '../src/image-runtime-socket.js';
import { buildIndexCandidate, type IndexCandidate } from '../src/indexer.js';
import { createMcpHandler, type McpRepository } from '../src/mcp.js';

const runtime = process.env.CODEHARBOR_TEST_READONLY_RUNTIME_IMAGE_ID;

test('real Git to trusted repository image and isolated readonly MCP query', {
  skip: !runtime,
  timeout: 180_000,
}, async () => {
  assert.match(runtime!, /^sha256:[a-f0-9]{64}$/);
  const runtimeImage = runtime as `sha256:${string}`;
  const root = await mkdtemp(join(tmpdir(), 'codeharbor-image-e2e-'));
  const oldPath = process.env.PATH;
  const git = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const docker = execFileSync('which', ['docker'], { encoding: 'utf8' }).trim();
  const source = join(root, 'source-alpha');
  const sourceBeta = join(root, 'source-beta');
  const shimDir = join(root, 'shim');
  const gitShim = join(shimDir, 'git');
  const dockerShim = join(shimDir, 'docker-audit');
  const dockerArgs = join(root, 'docker-creates.jsonl');
  const builderSocket = join(root, 'builder.sock');
  const querySocket = join(root, 'query.sock');
  const allowlist = join(root, 'trusted.sqlite');
  const buildToken = 'fixture-builder-token-'.repeat(3);
  const queryToken = 'fixture-query-token-'.repeat(3);
  const controllerId = `e2e_${randomUUID().replaceAll('-', '')}`;
  let builder: Awaited<ReturnType<typeof serveImageBuilder>> | undefined;
  let queryService: Awaited<ReturnType<typeof serveImageRuntime>> | undefined;
  let graph: ImageCodeGraphClient | undefined;
  let pipeline: ImageIndexPipeline | undefined;
  const candidatePaths: string[] = [];
  const published = new Map<string, { image: string; repoId: string; commit: string }>();
  let parallelGate: { arrived: number; enter: () => void; release: Promise<void> } | undefined;
  let http: HttpServer | undefined;
  const clients: Client[] = [];
  try {
    await mkdir(source);
    await mkdir(sourceBeta);
    await mkdir(shimDir);
    await writeFile(
      join(source, 'fixture.py'),
      'def orchidsentinel_reference():\n    return "orchidsentinel_fixture_marker"\n',
    );
    await writeFile(
      join(sourceBeta, 'fixture.py'),
      'def magnoliasentinel_reference():\n    return "magnoliasentinel_fixture_marker"\n',
    );
    const initializeGit = (directory: string) => {
      const runGit = (args: string[]) => execFileSync(git, args, { cwd: directory, stdio: 'ignore' });
      runGit(['init', '--initial-branch=main']);
      runGit(['config', 'user.name', 'CodeHarbor fixture']);
      runGit(['config', 'user.email', 'fixture@example.invalid']);
      runGit(['add', 'fixture.py']);
      runGit(['commit', '-m', 'fixture']);
    };
    initializeGit(source);
    initializeGit(sourceBeta);
    const commit = execFileSync(git, ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
    const betaCommit = execFileSync(git, ['rev-parse', 'HEAD'], { cwd: sourceBeta, encoding: 'utf8' }).trim();
    assert.notEqual(commit, betaCommit);
    const gitSource = pathToFileURL(source).href;
    const gitSourceBeta = pathToFileURL(sourceBeta).href;
    // The only mocked integration is the HTTPS transport: real Git clones a
    // disposable local repository; CodeGraph, Docker and both sockets are real.
    await writeFile(
      gitShim,
      `#!/usr/bin/env node\nconst cp=require('node:child_process');const args=process.argv.slice(2);const op=args.indexOf('clone')>=0?'clone':args.indexOf('ls-remote')>=0?'ls-remote':null;if(op){const pos=args.indexOf(op);args.splice(pos,0,'-c','protocol.file.allow=always');const remote=args.findIndex(x=>x.startsWith('https://git.example.invalid/'));if(remote>=0)args[remote]=args[remote].endsWith('/beta.git')?${JSON.stringify(gitSourceBeta)}:${JSON.stringify(gitSource)};}const p=cp.spawnSync(${JSON.stringify(git)},args,{stdio:'inherit',env:process.env});process.exit(p.status??1);\n`,
    );
    await chmod(gitShim, 0o700);
    await writeFile(
      dockerShim,
      `#!/usr/bin/env node\nconst fs=require('node:fs');const cp=require('node:child_process');const a=process.argv.slice(2);if(a[0]==='create')fs.appendFileSync(${JSON.stringify(dockerArgs)},JSON.stringify(a)+'\\n');if(a[0]==='rm'){const p=cp.spawnSync(${JSON.stringify(docker)},a,{encoding:'utf8',env:process.env});if(p.stdout)process.stdout.write(p.stdout);if(p.stderr)process.stderr.write(p.stderr);if(p.status!==0&&!/No such container/i.test(p.stderr||''))fs.writeFileSync(${JSON.stringify(join(root, 'remove-error'))},p.stderr||'missing stderr');process.exit(p.status??1)}const p=cp.spawnSync(${JSON.stringify(docker)},a,{stdio:'inherit',env:process.env});process.exit(p.status??1);\n`,
    );
    await chmod(dockerShim, 0o700);
    process.env.PATH = `${shimDir}:${oldPath}`;
    builder = await serveImageBuilder({
      path: builderSocket,
      token: buildToken,
      runtimeImage,
      allowlistPath: allowlist,
      timeoutMs: 120_000,
    });
    const builderClient = new SocketImageBuildExecutor({
      path: builderSocket,
      token: buildToken,
      runtimeImage,
      timeoutMs: 120_000,
    });
    const authorize = async (digest: `sha256:${string}`, repoId: string, commitId: string) => {
      const trusted = await getTrustedImage(allowlist, digest, process.getuid!());
      const exact =
        trusted?.imageId === digest &&
        trusted.repositoryId === repoId &&
        trusted.commit === commitId &&
        trusted.runtimeImage === runtimeImage;
      const reference = `oci://${digest}`;
      return (
        !!exact &&
        (!!pipeline?.isCandidate(reference, repoId, commitId) ||
          (published.get(repoId)?.image === reference && published.get(repoId)?.commit === commitId))
      );
    };
    const backend = new DockerImageQueryBackend(
      authorize,
      dockerShim,
      90_000,
      controllerId,
      new FileImageCreationFence(root, controllerId),
    );
    queryService = await serveImageRuntime({
      path: querySocket,
      token: queryToken,
      backend: {
        explore: async (request) => {
          if (parallelGate) {
            const gate = parallelGate;
            if (++gate.arrived === 10) gate.enter();
            await gate.release;
          }
          try {
            return await backend.explore(request);
          } catch (error) {
            console.error('Fixture runtime failure', error instanceof Error ? error.message : 'unknown');
            throw error;
          }
        },
        probe: (signal) => backend.probe(signal),
        close: () => backend.close(),
      },
      timeoutMs: 90_000,
    });
    graph = new ImageCodeGraphClient(new SocketImageQueryBackend(querySocket, queryToken, 90_000), 90_000);
    pipeline = new ImageIndexPipeline(
      runtimeImage,
      graph,
      async (request) => {
        const result = await buildIndexCandidate(request);
        candidatePaths.push(result.path);
        return result;
      },
      (request) =>
        buildRepositoryImage(request, async (...args) => {
          try {
            await builderClient.execute(...args);
          } catch (error) {
            throw new RepositoryImageError(
              'BUILD_FAILED',
              `Fixture builder failed: ${error instanceof Error ? error.message : 'unknown'}`,
            );
          }
        }),
    );
    const request = {
      dataDir: join(root, 'unused'),
      repositoryId: 'fixture-repo',
      branch: 'main',
      cloneUrl: 'https://git.example.invalid/fixture.git',
      allowedGitHosts: ['git.example.invalid'],
      gitUsername: 'fixture',
      token: 'fictional-token-not-in-image',
      codegraphBin: resolve('node_modules/.bin/codegraph'),
      timeoutMs: 90_000,
    };
    const built: IndexCandidate = await pipeline.build(request);
    const betaBuilt = await pipeline.build({
      ...request,
      repositoryId: 'fixture-beta',
      cloneUrl: 'https://git.example.invalid/beta.git',
    });
    assert.equal(built.commit, commit);
    assert.equal(betaBuilt.commit, betaCommit);
    assert.match(built.path, /^oci:\/\/sha256:[a-f0-9]{64}$/);
    for (const candidatePath of candidatePaths) await assert.rejects(access(candidatePath), { code: 'ENOENT' });
    const digest = parseImageReference(built.path);
    const betaDigest = parseImageReference(betaBuilt.path);
    assert.notEqual(digest, betaDigest);
    const trusted = await getTrustedImage(allowlist, digest, process.getuid!());
    assert.deepEqual(trusted, { imageId: digest, repositoryId: 'fixture-repo', commit, runtimeImage });
    assert.deepEqual(await getTrustedImage(allowlist, betaDigest, process.getuid!()), {
      imageId: betaDigest,
      repositoryId: 'fixture-beta',
      commit: betaCommit,
      runtimeImage,
    });
    const identity = { repoId: 'fixture-repo', commit };
    const result = await graph.withQuery((explore) =>
      explore(built.path, 'orchidsentinel_reference', undefined, identity),
    );
    assert.match(result, /orchidsentinel_reference/);
    assert.doesNotMatch(result, /fictional-token-not-in-image/);
    published.set(identity.repoId, { image: built.path, ...identity });
    pipeline.release(built.path);
    published.set('fixture-beta', { image: betaBuilt.path, repoId: 'fixture-beta', commit: betaCommit });
    pipeline.release(betaBuilt.path);
    let releaseParallel!: () => void;
    let enteredParallel!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseParallel = resolve;
    });
    const bothEntered = new Promise<void>((resolve) => {
      enteredParallel = resolve;
    });
    parallelGate = { arrived: 0, enter: enteredParallel, release };
    const simultaneous = Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        index % 2 === 0
          ? graph!.withQuery((explore) => explore(built.path, 'orchidsentinel_reference', undefined, identity))
          : graph!.withQuery((explore) =>
              explore(betaBuilt.path, 'magnoliasentinel_reference', undefined, {
                repoId: 'fixture-beta',
                commit: betaCommit,
              }),
            ),
      ),
    );
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        bothEntered,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Queries did not enter concurrently')), 10_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      parallelGate = undefined;
      releaseParallel();
    }
    const results = await simultaneous;
    results.forEach((result, index) => {
      assert.match(result, index % 2 === 0 ? /orchidsentinel_reference/ : /magnoliasentinel_reference/);
    });
    await assert.rejects(
      graph.withQuery((explore) =>
        explore(built.path, 'orchidsentinel_reference', undefined, { repoId: 'fixture-beta', commit: betaCommit }),
      ),
    );
    await assert.rejects(
      graph.withQuery((explore) => explore(betaBuilt.path, 'magnoliasentinel_reference', undefined, identity)),
    );
    await assert.rejects(
      graph.withQuery((explore) =>
        explore(built.path, 'orchidsentinel_reference', undefined, { ...identity, commit: betaCommit }),
      ),
    );
    const repos: McpRepository[] = [
      {
        id: 'fixture-repo',
        name: 'Alpha',
        status: 'ready',
        indexedCommit: commit,
        indexedAt: null,
        stale: false,
        projectPath: built.path,
      },
      {
        id: 'fixture-beta',
        name: 'Beta',
        status: 'ready',
        indexedCommit: betaCommit,
        indexedAt: null,
        stale: false,
        projectPath: betaBuilt.path,
      },
    ];
    http = createServer();
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const address = http.address();
    assert.ok(address && typeof address !== 'string');
    const host = `127.0.0.1:${address.port}`;
    const handle = createMcpHandler({
      allowedHosts: [host],
      codegraph: graph,
      async authenticate(req) {
        const value = req.headers.authorization;
        return value === 'Bearer fixture-alpha'
          ? 'fixture-repo'
          : value === 'Bearer fixture-beta'
            ? 'fixture-beta'
            : null;
      },
      async listRepositories(user) {
        return repos.filter((repo) => repo.id === user);
      },
      async getRepository(user, repoId) {
        return repos.find((repo) => repo.id === user && repo.id === repoId) ?? null;
      },
    });
    http.on('request', (req, res) => {
      void handle(req, res);
    });
    for (const [auth, own, ownSymbol, denied, deniedSymbol] of [
      ['fixture-alpha', 'fixture-repo', 'orchidsentinel_reference', 'fixture-beta', 'magnoliasentinel_reference'],
      ['fixture-beta', 'fixture-beta', 'magnoliasentinel_reference', 'fixture-repo', 'orchidsentinel_reference'],
    ]) {
      const client = new Client({ name: `fixture-${own}`, version: '1' });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://${host}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${auth}` } },
        }),
      );
      const tools = await client.listTools();
      assert.ok(tools.tools.some((tool) => tool.name === 'codegraph_explore'));
      const listing = await client.callTool({ name: 'list_repositories', arguments: {} });
      assert.match(JSON.stringify(listing), new RegExp(own));
      assert.doesNotMatch(JSON.stringify(listing), new RegExp(denied));
      const ownResult = await client.callTool({
        name: 'codegraph_explore',
        arguments: { repo_id: own, query: ownSymbol },
      });
      assert.notEqual(ownResult.isError, true);
      assert.match(JSON.stringify(ownResult), new RegExp(ownSymbol));
      const denial = await client.callTool({
        name: 'codegraph_explore',
        arguments: { repo_id: denied, query: deniedSymbol },
      });
      assert.equal(denial.isError, true);
      assert.doesNotMatch(JSON.stringify(denial), new RegExp(deniedSymbol));
    }
    const creates = (await readFile(dockerArgs, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    assert.ok(creates.length >= 2);
    for (const args of creates) {
      assert.ok(args.includes('--read-only'));
      assert.equal(args[args.indexOf('--network') + 1], 'none');
      for (const forbidden of ['--volume', '-v', '--mount', '--privileged']) assert.ok(!args.includes(forbidden));
    }
    // Keep test-owned image for explicit caller-controlled pruning; never remove
    // any preexisting image or production data from this integration test.
  } finally {
    try {
      console.error('Fixture Docker cleanup diagnostic', await readFile(join(root, 'remove-error'), 'utf8'));
    } catch {
      /* no unexpected cleanup error */
    }
    process.env.PATH = oldPath;
    for (const client of clients) await client.close().catch(() => {});
    if (http) await new Promise<void>((resolveClose) => http!.close(() => resolveClose()));
    await graph?.close().catch(() => {});
    await queryService?.close().catch(() => {});
    await builder?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
