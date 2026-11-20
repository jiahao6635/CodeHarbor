import { readFile } from 'node:fs/promises';
import { DockerImageQueryBackend } from './docker-image-query.js';
import { SocketImageAuthorizer } from './image-authorizer.js';
import { getTrustedImage, serveImageBuilder } from './image-build-socket.js';
import { FileImageCreationFence } from './image-creation-fence.js';
import { serveImageRuntime } from './image-runtime-socket.js';
import { createLogger } from './logger.js';
import { queryConcurrency } from './query-concurrency.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error('Incomplete image controller configuration');
  return value;
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error('Invalid image controller storage limits');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error('Invalid image controller storage limits');
  return value;
}

/** This process alone has Docker access; the gateway uses restricted Unix sockets. */
async function main() {
  const maxConcurrent = queryConcurrency(process.env.CODEHARBOR_MCP_QUERY_CONCURRENCY);
  const runtimeImage = required('CODEHARBOR_REPOSITORY_RUNTIME_IMAGE');
  if (!/^sha256:[a-f0-9]{64}$/.test(runtimeImage)) throw new Error('Invalid runtime image ID');
  const runtimeId = runtimeImage as `sha256:${string}`;
  const querySocket = required('CODEHARBOR_IMAGE_QUERY_SOCKET');
  const buildSocket = required('CODEHARBOR_IMAGE_BUILD_SOCKET');
  const authSocket = required('CODEHARBOR_IMAGE_AUTH_SOCKET');
  const allowlistPath = required('CODEHARBOR_IMAGE_ALLOWLIST');
  const fenceDirectory = required('CODEHARBOR_IMAGE_FENCE_DIR');
  const workDir = required('CODEHARBOR_IMAGE_BUILD_WORK_DIR');
  const controllerId = required('CODEHARBOR_IMAGE_CONTROLLER_ID');
  const maxTrustedImages = boundedInteger('CODEHARBOR_IMAGE_MAX_IMAGES', 512, 3, 10_000);
  const maxStorageBytes = boundedInteger(
    'CODEHARBOR_IMAGE_STORAGE_BUDGET_BYTES',
    64 * 1024 * 1024 * 1024,
    2 * 1024 * 1024 * 1024,
    Number.MAX_SAFE_INTEGER,
  );
  const [queryToken, buildToken, authToken] = await Promise.all([
    readFile(required('CODEHARBOR_IMAGE_QUERY_TOKEN_FILE'), 'utf8'),
    readFile(required('CODEHARBOR_IMAGE_BUILD_TOKEN_FILE'), 'utf8'),
    readFile(required('CODEHARBOR_IMAGE_AUTH_TOKEN_FILE'), 'utf8'),
  ]);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('Image controller requires Unix');
  const authorizer = new SocketImageAuthorizer(authSocket, authToken.trim());
  const backend = new DockerImageQueryBackend(
    async (digest, repoId, commit) => {
      const record = await getTrustedImage(allowlistPath, digest, uid);
      return (
        !!record &&
        record.repositoryId === repoId &&
        record.commit === commit &&
        record.runtimeImage === runtimeId &&
        (await authorizer.authorize(digest, repoId, commit))
      );
    },
    'docker',
    30_000,
    controllerId,
    new FileImageCreationFence(fenceDirectory, controllerId),
  );
  let builder: Awaited<ReturnType<typeof serveImageBuilder>> | undefined;
  let runtime: Awaited<ReturnType<typeof serveImageRuntime>> | undefined;
  try {
    builder = await serveImageBuilder({
      path: buildSocket,
      token: buildToken.trim(),
      runtimeImage: runtimeId,
      allowlistPath,
      workDir,
      socketMode: 0o660,
      maxTrustedImages,
      maxStorageBytes,
    });
    runtime = await serveImageRuntime({
      path: querySocket,
      token: queryToken.trim(),
      backend,
      socketMode: 0o660,
      maxConcurrent,
    });
    // Recovery must happen only after the unique controller socket is bound.
    await backend.probe(AbortSignal.timeout(30_000));
  } catch (error) {
    await runtime?.close().catch(() => {});
    await builder?.close().catch(() => {});
    throw error;
  }
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    try {
      await runtime?.close();
      await builder?.close();
      process.exitCode = 0;
    } catch {
      process.exitCode = 1;
    }
  }
  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

main().catch(() => {
  createLogger({ name: 'codeharbor-image-controller' }).fatal(
    'Image controller startup failed; check protected configuration and recovery state',
  );
  process.exitCode = 1;
});
