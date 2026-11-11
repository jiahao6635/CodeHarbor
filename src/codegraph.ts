import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** The gateway and worker share these operations regardless of index storage. */
export type GraphClient = Pick<CodeGraphClient, 'withQuery' | 'withExclusive' | 'probe' | 'close'>;
export type RepositoryIdentity = { repoId: string; commit: string };
export type Explore = (path: string, query: string, signal?: AbortSignal, identity?: RepositoryIdentity) => Promise<string>;

/** A stdio transport whose subprocess and ordinary descendants share a killable group. */
export class ManagedCodeGraphTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child?: ChildProcess;
  private exited?: Promise<void>;
  private closing?: Promise<void>;
  private buffer = new ReadBuffer({ maxBufferSize: 4 * 1024 * 1024 });

  constructor(private command: string, private cwd: string) {}

  async start(): Promise<void> {
    if (this.child) throw new Error('Transport already started');
    if (process.platform === 'win32') throw new Error('Process group isolation requires Unix');
    const child = spawn(this.command, ['serve', '--mcp'], {
      cwd: this.cwd,
      detached: true,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: this.cwd,
        CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_NO_WATCH: '1', CODEGRAPH_NO_DOWNLOAD: '1', DO_NOT_TRACK: '1',
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.child = child;
    this.exited = new Promise<void>((resolve) => child.once('close', () => { this.onclose?.(); resolve(); }));
    child.on('error', (error) => this.onerror?.(error));
    child.stdin?.on('error', (error) => this.onerror?.(error));
    child.stdout?.on('error', (error) => this.onerror?.(error));
    child.stdout?.on('data', (chunk: Buffer) => {
      try {
        this.buffer.append(chunk);
        for (;;) {
          const message = this.buffer.readMessage();
          if (!message) break;
          this.onmessage?.(message);
        }
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error('Invalid upstream message'));
        void this.close().catch(() => {});
      }
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stream = this.child?.stdin;
    if (!stream || stream.destroyed) throw new Error('CodeGraph transport is closed');
    await new Promise<void>((resolve, reject) => {
      stream.write(serializeMessage(message), (error) => error ? reject(error) : resolve());
    });
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    const child = this.child;
    const exited = this.exited;
    if (!child || !exited) return;
    this.closing = (async () => {
      child.stdin?.end();
      const wait = async (ms: number) => new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), ms);
        void exited.then(() => { clearTimeout(timer); resolve(true); });
      });
      const signalGroup = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        try { process.kill(-child.pid, signal); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      };
      await wait(500);
      // Even if the leader has exited, it may have left descendants in its group.
      signalGroup('SIGTERM');
      await wait(500);
      signalGroup('SIGKILL');
      if (!await wait(2_000)) throw new Error('CodeGraph process group did not close');
      this.buffer.clear();
    })();
    return this.closing;
  }
}

/** A single, serialized upstream MCP connection shared by all users and repositories. */
export class CodeGraphClient {
  private client: Client | undefined;
  private transport: ManagedCodeGraphTransport | undefined;
  private tail: Promise<void> = Promise.resolve();
  private unsafe = false;

  constructor(
    private readonly command: string,
    private readonly cwd: string,
    private readonly timeoutMs = 30_000,
  ) {}

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  private async connect(): Promise<Client> {
    if (this.unsafe) throw new Error('CodeGraph process shutdown failed; restart required');
    if (this.client) return this.client;
    if (this.transport) await this.closeConnection();
    const client = new Client({ name: 'codeharbor', version: '0.1.0' });
    const transport = new ManagedCodeGraphTransport(this.command, this.cwd);
    this.transport = transport;
    try {
      await client.connect(transport, { timeout: this.timeoutMs });
      const { tools } = await client.listTools(undefined, { timeout: this.timeoutMs });
      const tool = tools.find((entry) => entry.name === 'codegraph_explore');
      const props = tool?.inputSchema?.properties;
      if (!tool || !props || !('query' in props) || !('projectPath' in props)) {
        throw new Error('Incompatible CodeGraph MCP tool schema');
      }
      this.client = client;
      client.onclose = () => { if (this.client === client) this.client = undefined; };
      return client;
    } catch (error) {
      await this.closeConnection().catch(() => {});
      throw error;
    }
  }

  private async closeConnection(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    if (client || transport) {
      try { if (client) await client.close(); else await transport!.close(); }
      catch (error) { this.unsafe = true; throw error; }
    }
  }

  private async query(path: string, query: string, signal?: AbortSignal): Promise<string> {
      if (signal?.aborted) throw new Error('Request cancelled');
      try {
        const client = await this.connect();
        const result = await client.callTool({ name: 'codegraph_explore', arguments: { projectPath: path, query } }, undefined, {
          timeout: this.timeoutMs,
          signal,
        });
        if (result.isError || !Array.isArray(result.content) || !result.content.every((item) => item.type === 'text')) {
          throw new Error('CodeGraph query failed');
        }
        const text = result.content.map((item) => item.type === 'text' ? item.text : '').join('\n');
        if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('CodeGraph result exceeded size limit');
        return text.split(path).join('[repository]');
      } catch (error) {
        await this.closeConnection().catch(() => {});
        throw error;
      }
  }

  /** Resolve the current repository version inside this lock, not before it. */
  async withQuery<T>(operation: (explore: Explore) => Promise<T>): Promise<T> {
    return this.serialized(() => operation((path, query, signal) => this.query(path, query, signal)));
  }

  /** Drain all queries, close cached upstream handles, and publish before later queries resume. */
  async withExclusive<T>(operation: (explore: Explore) => Promise<T>): Promise<T> {
    return this.serialized(async () => {
      if (this.unsafe) throw new Error('CodeGraph process shutdown failed; restart required');
      await this.closeConnection();
      try { return await operation((path, query, signal) => this.query(path, query, signal)); }
      finally { await this.closeConnection(); }
    });
  }

  async close(): Promise<void> {
    await this.withExclusive(async () => {});
  }

  /** Verify the subprocess can start and advertises the expected MCP tool. */
  async probe(): Promise<void> {
    await this.serialized(async () => {
      try {
        const client = await this.connect();
        const { tools } = await client.listTools(undefined, { timeout: this.timeoutMs });
        const tool = tools.find((entry) => entry.name === 'codegraph_explore');
        const props = tool?.inputSchema?.properties;
        if (!tool || !props || !('query' in props) || !('projectPath' in props)) {
          throw new Error('Incompatible CodeGraph MCP tool schema');
        }
      } catch (error) {
        await this.closeConnection().catch(() => {});
        throw error;
      }
    });
  }
}
