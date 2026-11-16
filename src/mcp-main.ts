import { readFile } from 'node:fs/promises';
import { createLogger } from './logger.js';
import { createMcpService, SocketMcpBackend } from './mcp-service.js';

async function main(): Promise<void> {
  const path = process.env.CODEHARBOR_INTERNAL_MCP_SOCKET;
  const tokenFile = process.env.CODEHARBOR_INTERNAL_MCP_TOKEN_FILE;
  if (!path || !tokenFile) throw new Error('Internal MCP socket and token file are required');
  const token = (await readFile(tokenFile, 'utf8')).trim();
  const port = Number(process.env.PORT ?? '8081');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const host = process.env.CODEHARBOR_BIND ?? '127.0.0.1';
  const list = (value?: string) =>
    value
      ?.split(',')
      .map((item) => item.trim())
      .filter(Boolean) ?? [];
  const allowedHosts = list(process.env.CODEHARBOR_ALLOWED_HOSTS);
  if (!allowedHosts.length) allowedHosts.push(`127.0.0.1:${port}`, `localhost:${port}`);
  const app = createMcpService({
    backend: new SocketMcpBackend(path, token),
    allowedHosts,
    allowedOrigins: list(process.env.CODEHARBOR_ALLOWED_ORIGINS),
  });
  await app.listen({ port, host });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await app.close();
      process.exitCode = 0;
    } catch {
      process.exitCode = 1;
    }
  };
  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

main().catch(() => {
  createLogger({ name: 'codeharbor-mcp' }).fatal('MCP startup failed; check service configuration');
  process.exitCode = 1;
});
