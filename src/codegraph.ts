import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** A single, serialized upstream MCP connection shared by all users and repositories. */
export class CodeGraphClient {
  private client: Client | undefined;
  private tail: Promise<void> = Promise.resolve();

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
    if (this.client) return this.client;
    const client = new Client({ name: 'codeharbor', version: '0.1.0' });
    const transport = new StdioClientTransport({
      command: this.command,
      args: ['serve', '--mcp'],
      cwd: this.cwd,
      // Do not pass the gateway's credentials or secrets to the subprocess.
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: this.cwd,
        CODEGRAPH_NO_DAEMON: '1',
        CODEGRAPH_NO_WATCH: '1',
        DO_NOT_TRACK: '1',
      },
      stderr: 'ignore',
      maxBufferSize: 4 * 1024 * 1024,
    });
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
      await client.close().catch(() => {});
      throw error;
    }
  }

  private async closeConnection(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) await client.close();
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
  async withQuery<T>(operation: (explore: (path: string, query: string, signal?: AbortSignal) => Promise<string>) => Promise<T>): Promise<T> {
    return this.serialized(() => operation((path, query, signal) => this.query(path, query, signal)));
  }

  /** Drain all queries, close cached upstream handles, and publish before later queries resume. */
  async withExclusive<T>(operation: (explore: (path: string, query: string, signal?: AbortSignal) => Promise<string>) => Promise<T>): Promise<T> {
    return this.serialized(async () => {
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
