import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { IMAGE_PROJECT_PATH, type ImageDigest, type ImageQueryBackend, validImageIdentity } from './image-codegraph.js';
import type { ImageCreationFence } from './image-creation-fence.js';
import { ImageRuntimeRequestError, ImageRuntimeUncertainError } from './image-runtime-errors.js';

const imagePattern = /^sha256:[a-f0-9]{64}$/;
const containerPattern = /^[a-f0-9]{64}$/;
const namePattern = /^codeharbor-query-[a-f0-9-]{36}$/;
const ownerPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ownerLabel = 'io.codeharbor.image-query-owner';
const kindLabel = 'io.codeharbor.image-query-kind';

/** Fixed arguments for the trusted, patched readonly CodeGraph runtime image. */
export function dockerCreateArguments(digest: string, name: string, owner: string): string[] {
  if (!imagePattern.test(digest) || !namePattern.test(name) || !ownerPattern.test(owner))
    throw new Error('Invalid container arguments');
  return [
    'create',
    '--interactive',
    '--rm',
    '--name',
    name,
    '--label',
    `${ownerLabel}=${owner}`,
    '--label',
    `${kindLabel}=readonly`,
    '--read-only',
    '--network',
    'none',
    '--user',
    '1000:1000',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '128',
    '--memory',
    '512m',
    '--cpus',
    '1',
    '--workdir',
    IMAGE_PROJECT_PATH,
    '--env',
    'HOME=/tmp',
    '--env',
    'CODEGRAPH_MCP_READ_ONLY=1',
    '--env',
    'CODEGRAPH_NO_DAEMON=1',
    '--env',
    'CODEGRAPH_NO_WATCH=1',
    '--env',
    'CODEGRAPH_NO_DOWNLOAD=1',
    '--env',
    'DO_NOT_TRACK=1',
    '--entrypoint',
    '/usr/local/bin/node',
    digest,
    '/readonly-codegraph/dist/bin/codegraph.js',
    'serve',
    '--mcp',
    '--path',
    IMAGE_PROJECT_PATH,
  ];
}

type CommandResult = { code: number | null; stdout: string; stderr: string };

/** No shell, credentials in arguments, or inherited environment beyond the runtime location. */
async function dockerCommand(binary: string, args: string[], signal: AbortSignal): Promise<CommandResult> {
  if (signal.aborted) throw new Error('Docker operation cancelled');
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: true,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
    });
    let stdout = '';
    let stderr = '';
    let failed = false;
    const stop = () => {
      failed = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already exited */
      }
    };
    const onAbort = () => stop();
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 8192) stop();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 8192) stop();
    });
    child.once('error', () => {
      signal.removeEventListener('abort', onAbort);
      reject(new Error('Docker operation failed'));
    });
    child.once('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (failed) reject(new Error('Docker operation cancelled or exceeded output limit'));
      else resolve({ code, stdout, stderr });
    });
  });
}

/** The container is created separately; the backend always removes it after this transport stops. */
class DockerStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child?: ChildProcess;
  private exited?: Promise<void>;
  private buffer = new ReadBuffer({ maxBufferSize: 4 * 1024 * 1024 });

  constructor(
    private readonly binary: string,
    private readonly id: string,
  ) {}

  async start(): Promise<void> {
    if (this.child || !containerPattern.test(this.id)) throw new Error('Invalid Docker transport');
    const child = spawn(this.binary, ['start', '--attach', '--interactive', this.id], {
      stdio: ['pipe', 'pipe', 'ignore'],
      shell: false,
      detached: true,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
    });
    this.child = child;
    this.exited = new Promise<void>((resolve) =>
      child.once('close', () => {
        this.onclose?.();
        resolve();
      }),
    );
    child.on('error', () => this.onerror?.(new Error('Docker transport failed')));
    child.stdin?.on('error', () => this.onerror?.(new Error('Docker transport failed')));
    child.stdout?.on('data', (chunk: Buffer) => {
      try {
        this.buffer.append(chunk);
        for (;;) {
          const message = this.buffer.readMessage();
          if (!message) break;
          this.onmessage?.(message);
        }
      } catch {
        this.onerror?.(new Error('Invalid upstream message'));
        void this.close().catch(() => {});
      }
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', () => reject(new Error('Docker start failed')));
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stream = this.child?.stdin;
    if (!stream || stream.destroyed) throw new Error('Docker transport is closed');
    await new Promise<void>((resolve, reject) =>
      stream.write(serializeMessage(message), (error) => (error ? reject(error) : resolve())),
    );
  }

  async close(): Promise<void> {
    const child = this.child;
    const exited = this.exited;
    if (!child || !exited) return;
    child.stdin?.end();
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already exited */
    }
    await exited;
    this.child = undefined;
    this.buffer.clear();
  }
}

/**
 * Runs only in the isolated runtime controller, never in the public gateway.
 * authorizeImage must resolve the digest, repository ID and commit against trusted metadata.
 * The controller must not accept arbitrary client-selected image IDs.
 */
export class DockerImageQueryBackend implements ImageQueryBackend {
  private readonly active = new Set<string>();
  private uncertain = false;
  private readonly clients = new Set<Client>();
  private readonly operations = new Set<Promise<string>>();
  private readonly controllers = new Set<AbortController>();
  private recovery?: Promise<void>;
  private recovered = false;

  constructor(
    private readonly authorizeImage: (digest: ImageDigest, repoId: string, commit: string) => Promise<boolean>,
    private readonly docker: string,
    private readonly operationTimeoutMs: number,
    private readonly controllerId: string,
    private readonly fence?: ImageCreationFence,
  ) {
    if (
      process.platform === 'win32' ||
      !Number.isSafeInteger(operationTimeoutMs) ||
      operationTimeoutMs < 1 ||
      !ownerPattern.test(controllerId)
    )
      throw new Error('Invalid Docker runtime configuration');
  }

  /** Must only run after the controller has exclusively bound its private Unix socket. */
  private async ensureRecovered(): Promise<void> {
    if (this.uncertain) throw new Error('Docker cleanup requires operator intervention');
    if (this.recovered) return;
    this.recovery ??= (async () => {
      try {
        await this.fence?.assertClear();
        const list = await dockerCommand(
          this.docker,
          [
            'ps',
            '--all',
            '--no-trunc',
            '--filter',
            `label=${ownerLabel}=${this.controllerId}`,
            '--filter',
            `label=${kindLabel}=readonly`,
            '--format',
            '{{.ID}}',
          ],
          AbortSignal.timeout(this.operationTimeoutMs),
        );
        if (list.code !== 0) throw new Error('Cannot list managed containers');
        const ids = list.stdout.trim() ? list.stdout.trim().split('\n') : [];
        if (ids.length > 100 || ids.some((id) => !containerPattern.test(id)))
          throw new Error('Invalid managed container list');
        for (const id of ids) {
          const details = await dockerCommand(
            this.docker,
            ['inspect', '--type', 'container', '--format', '{{.Name}}|{{json .Config.Labels}}', id],
            AbortSignal.timeout(this.operationTimeoutMs),
          );
          if (details.code !== 0) throw new Error('Cannot verify managed container');
          const divider = details.stdout.indexOf('|');
          if (divider < 0) throw new Error('Invalid managed container details');
          const name = details.stdout.slice(0, divider).trim().replace(/^\//, '');
          const labels: unknown = JSON.parse(details.stdout.slice(divider + 1));
          if (
            !namePattern.test(name) ||
            !labels ||
            typeof labels !== 'object' ||
            Array.isArray(labels) ||
            (labels as Record<string, unknown>)[ownerLabel] !== this.controllerId ||
            (labels as Record<string, unknown>)[kindLabel] !== 'readonly'
          )
            throw new Error('Container ownership does not match');
          await this.remove(id);
        }
        this.recovered = true;
      } catch {
        this.uncertain = true;
        throw new Error('Docker recovery requires operator intervention');
      }
    })();
    await this.recovery;
  }

  /** Observability only; an uncertain backend refuses every query until an operator reconciles Docker state. */
  isUncertain(): boolean {
    return this.uncertain;
  }

  async status(): Promise<{ uncertain: boolean }> {
    return { uncertain: this.uncertain };
  }

  async probe(signal: AbortSignal): Promise<void> {
    if (this.uncertain) throw new Error('Docker cleanup requires operator intervention');
    await this.ensureRecovered();
    const result = await dockerCommand(this.docker, ['version', '--format', '{{.Server.Version}}'], signal);
    if (result.code !== 0 || !result.stdout.trim()) throw new Error('Docker runtime unavailable');
  }

  private async remove(name: string): Promise<void> {
    if (!namePattern.test(name) && !containerPattern.test(name))
      throw new Error('Invalid managed container identifier');
    const deadline = AbortSignal.timeout(this.operationTimeoutMs);
    // Docker CLI may report success for `rm -f` even if the target does not
    // exist. Only an explicit inspect of the immutable ID establishes absence.
    const inspect = async (target: string): Promise<string | null> => {
      const result = await dockerCommand(
        this.docker,
        ['inspect', '--type', 'container', '--format', '{{.Id}}|{{.Name}}|{{json .Config.Labels}}', target],
        deadline,
      );
      if (result.code !== 0) {
        if (
          result.code === 1 &&
          result.stderr.trim() === `Error response from daemon: No such container: ${target}` &&
          !result.stdout.trim()
        )
          return null;
        throw new Error('Cannot verify container cleanup');
      }
      const first = result.stdout.indexOf('|');
      const second = result.stdout.indexOf('|', first + 1);
      if (first < 0 || second < 0) throw new Error('Invalid container inspection');
      const id = result.stdout.slice(0, first).trim();
      const containerName = result.stdout
        .slice(first + 1, second)
        .trim()
        .replace(/^\//, '');
      const labels: unknown = JSON.parse(result.stdout.slice(second + 1));
      if (
        !containerPattern.test(id) ||
        !namePattern.test(containerName) ||
        (containerPattern.test(target) ? target !== id : target !== containerName) ||
        !labels ||
        typeof labels !== 'object' ||
        Array.isArray(labels) ||
        (labels as Record<string, unknown>)[ownerLabel] !== this.controllerId ||
        (labels as Record<string, unknown>)[kindLabel] !== 'readonly'
      )
        throw new Error('Container ownership does not match');
      return id;
    };
    try {
      const id = await inspect(name);
      if (id) {
        // `--rm` may already be removing the container. Regardless of rm's
        // status, wait for Docker to confirm that the exact ID no longer exists.
        await dockerCommand(this.docker, ['rm', '--force', id], deadline);
        while (await inspect(id)) await delay(100, undefined, { signal: deadline });
      }
      this.active.delete(name);
    } catch {
      this.uncertain = true;
      throw new Error('Docker container cleanup failed');
    }
  }

  async explore(request: Parameters<ImageQueryBackend['explore']>[0]): Promise<string> {
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    this.controllers.add(controller);
    const operation = this.execute({ ...request, signal });
    this.operations.add(operation);
    try {
      const result = await operation;
      if (this.uncertain) throw new ImageRuntimeUncertainError();
      return result;
    } catch (error) {
      if (this.uncertain)
        throw new ImageRuntimeUncertainError(
          'Container creation outcome is uncertain or cleanup requires operator intervention',
        );
      throw new ImageRuntimeRequestError(
        error instanceof Error && error.message === 'Repository image unavailable' ? error.message : undefined,
      );
    } finally {
      this.operations.delete(operation);
      this.controllers.delete(controller);
    }
  }

  private async execute(request: Parameters<ImageQueryBackend['explore']>[0]): Promise<string> {
    if (
      this.uncertain ||
      request.readOnlyRoot !== true ||
      request.projectPath !== IMAGE_PROJECT_PATH ||
      !imagePattern.test(request.digest) ||
      !validImageIdentity(request) ||
      typeof request.query !== 'string' ||
      !request.query.trim() ||
      request.query.length > 2000
    )
      throw new Error('Invalid repository image request');
    if (
      request.signal.aborted ||
      !(await this.authorizeImage(request.digest, request.repoId, request.commit)) ||
      request.signal.aborted
    )
      throw new Error('Repository image unavailable');
    await this.ensureRecovered();
    const name = `codeharbor-query-${randomUUID()}`;
    this.active.add(name);
    let created = false;
    let containerId: string | undefined;
    let submitted = false;
    let fenced = false;
    let client: Client | undefined;
    let transport: DockerStdioTransport | undefined;
    try {
      if (this.fence) {
        try {
          await this.fence.begin(name);
          fenced = true;
        } catch {
          this.uncertain = true;
          throw new Error('Image creation fence requires operator intervention');
        }
      }
      // A cancellation during the durable fence write has not reached Docker.
      if (request.signal.aborted) throw new Error('Request cancelled before container creation');
      let create: CommandResult;
      try {
        submitted = true;
        create = await dockerCommand(
          this.docker,
          dockerCreateArguments(request.digest, name, this.controllerId),
          request.signal,
        );
      } catch {
        // The daemon may complete a timed-out create after the CLI is killed.
        // Fail closed until an operator checks for that container.
        this.uncertain = true;
        throw new Error('Container creation outcome is uncertain');
      }
      if (create.code !== 0) {
        // A client-side or transport failure may occur after the daemon accepted
        // the create. Preserve the durable fence until an operator reconciles it.
        this.uncertain = true;
        throw new Error('Container creation outcome is uncertain');
      }
      if (!containerPattern.test(create.stdout.trim())) {
        this.uncertain = true;
        throw new Error('Container creation outcome is uncertain');
      }
      created = true;
      containerId = create.stdout.trim();
      // An image can declare VOLUME and cause Docker to mount writable storage
      // despite --read-only. Verify the effective container before starting it.
      const inspected = await dockerCommand(
        this.docker,
        [
          'inspect',
          '--type',
          'container',
          '--format',
          '{{json .Image}}|{{json .HostConfig.ReadonlyRootfs}}|{{json .HostConfig.NetworkMode}}|{{json .Mounts}}',
          containerId,
        ],
        request.signal,
      );
      const fields = inspected.stdout.trim().split('|');
      if (inspected.code !== 0 || fields.length !== 4) throw new Error('Cannot verify repository container');
      const [image, readOnlyRoot, network, mounts]: unknown[] = fields.map((field) => JSON.parse(field));
      if (
        image !== request.digest ||
        readOnlyRoot !== true ||
        network !== 'none' ||
        !Array.isArray(mounts) ||
        mounts.length !== 0
      ) {
        throw new Error('Unsafe repository container configuration');
      }
      transport = new DockerStdioTransport(this.docker, containerId);
      client = new Client({ name: 'codeharbor-image-runtime', version: '0.1.0' });
      this.clients.add(client);
      await client.connect(transport, { timeout: this.operationTimeoutMs, signal: request.signal });
      const { tools } = await client.listTools(undefined, { timeout: this.operationTimeoutMs, signal: request.signal });
      const tool = tools.find((entry) => entry.name === 'codegraph_explore');
      if (
        !tool?.inputSchema?.properties ||
        !('query' in tool.inputSchema.properties) ||
        !('projectPath' in tool.inputSchema.properties)
      ) {
        throw new Error('Incompatible readonly CodeGraph runtime');
      }
      const result = await client.callTool(
        { name: 'codegraph_explore', arguments: { projectPath: IMAGE_PROJECT_PATH, query: request.query } },
        undefined,
        { timeout: this.operationTimeoutMs, signal: request.signal },
      );
      if (result.isError || !Array.isArray(result.content) || !result.content.every((item) => item.type === 'text'))
        throw new Error('Image query failed');
      const text = result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n');
      if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('Image query result too large');
      return text;
    } finally {
      if (client) {
        this.clients.delete(client);
        await client.close().catch(() => {});
      } else if (transport) await transport.close().catch(() => {});
      // Even a failed docker create might have created a named container.
      if (submitted || created) {
        await this.remove(containerId ?? name);
        this.active.delete(name);
      } else this.active.delete(name);
      if (fenced && this.fence && !this.uncertain) {
        try {
          await this.fence.complete(name);
        } catch {
          this.uncertain = true;
          // biome-ignore lint/correctness/noUnsafeFinally: a fence that cannot complete must fail the query even on success
          throw new Error('Image creation fence requires operator intervention');
        }
      }
    }
  }

  async close(): Promise<void> {
    for (const controller of this.controllers) controller.abort();
    for (const client of this.clients) await client.close();
    this.clients.clear();
    await Promise.allSettled(this.operations);
    if (this.recovery) await this.recovery;
    for (const name of this.active) await this.remove(name);
    if (this.uncertain) throw new Error('Docker cleanup requires operator intervention');
  }
}
