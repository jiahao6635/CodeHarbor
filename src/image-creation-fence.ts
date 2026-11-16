import { constants } from 'node:fs';
import { lstat, open, readdir, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

/** A fence survives controller restarts and requires explicit operator recovery. */
export interface ImageCreationFence {
  assertClear(): Promise<void>;
  begin(containerName: string): Promise<void>;
  complete(containerName: string): Promise<void>;
}

const ownerPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const namePattern = /^codeharbor-query-[a-f0-9-]{36}$/;

/**
 * The directory must be persistent, owned by the controller UID and mode 0700.
 * It must not be on a disposable container layer. Never automatically clear a
 * stale marker: the Docker daemon may complete a prior create after a timeout.
 */
export class FileImageCreationFence implements ImageCreationFence {
  private readonly markerPrefix: string;

  constructor(
    private readonly directory: string,
    private readonly controllerId: string,
  ) {
    if (!isAbsolute(directory) || !ownerPattern.test(controllerId))
      throw new Error('Invalid image fence configuration');
    this.markerPrefix = `${controllerId}.pending.`;
  }

  private async checkDirectory(): Promise<void> {
    const info = await lstat(this.directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())
    )
      throw new Error('Unsafe image fence directory');
  }

  private async syncDirectory(): Promise<void> {
    const handle = await open(this.directory, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async assertClear(): Promise<void> {
    await this.checkDirectory();
    // The prefix includes the legacy <controller>.pending.json marker.
    if ((await readdir(this.directory)).some((name) => name.startsWith(this.markerPrefix))) {
      throw new Error('Image creation fence requires operator intervention');
    }
  }

  async begin(containerName: string): Promise<void> {
    if (!namePattern.test(containerName)) throw new Error('Invalid image fence container');
    await this.checkDirectory();
    const path = join(this.directory, `${this.markerPrefix}${containerName}.json`);
    const handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(JSON.stringify({ version: 1, controllerId: this.controllerId, containerName }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.syncDirectory();
  }

  async complete(containerName: string): Promise<void> {
    if (!namePattern.test(containerName)) throw new Error('Invalid image fence container');
    await this.checkDirectory();
    const path = join(this.directory, `${this.markerPrefix}${containerName}.json`);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Image fence ownership mismatch');
      throw error;
    }
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.size > 1024 ||
        (info.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && info.uid !== process.getuid())
      )
        throw new Error('Invalid image fence marker');
      const marker: unknown = JSON.parse(await handle.readFile('utf8'));
      if (
        !marker ||
        typeof marker !== 'object' ||
        Array.isArray(marker) ||
        (marker as Record<string, unknown>).version !== 1 ||
        (marker as Record<string, unknown>).controllerId !== this.controllerId ||
        (marker as Record<string, unknown>).containerName !== containerName
      )
        throw new Error('Image fence ownership mismatch');
      const current = await lstat(path);
      if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino)
        throw new Error('Image fence marker changed');
      await unlink(path);
      await this.syncDirectory();
    } finally {
      await handle.close();
    }
  }
}
