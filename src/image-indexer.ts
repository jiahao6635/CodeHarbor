import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GraphClient } from './codegraph.js';
import { buildRepositoryImage, type RepositoryImageBuildResult, type RepositoryImageRequest } from './image-builder.js';
import { parseImageReference } from './image-codegraph.js';
import { buildIndexCandidate, type IndexCandidate, type IndexRequest } from './indexer.js';

/** Build checkouts are disposable and never become the published repository. */
export class ImageIndexPipeline {
  private readonly candidates = new Map<string, { repoId: string; commit: string }>();
  constructor(
    private readonly runtimeImage: `sha256:${string}`,
    private readonly graph: GraphClient,
    private readonly buildIndex: (request: IndexRequest) => Promise<IndexCandidate> = buildIndexCandidate,
    private readonly buildImage: (
      request: RepositoryImageRequest,
    ) => Promise<RepositoryImageBuildResult> = buildRepositoryImage,
  ) {
    if (!/^sha256:[a-f0-9]{64}$/.test(runtimeImage)) throw new Error('Invalid runtime image ID');
  }

  async build(request: IndexRequest): Promise<IndexCandidate> {
    const root = await mkdtemp(join(tmpdir(), 'codeharbor-image-index-'));
    let result: IndexCandidate;
    try {
      const candidate = await this.buildIndex({ ...request, dataDir: root });
      const image = await this.buildImage({
        dataDir: root,
        repositoryId: request.repositoryId,
        candidate,
        runtimeImage: this.runtimeImage,
      });
      if (image.repositoryId !== request.repositoryId || image.commit !== candidate.commit)
        throw new Error('Image metadata mismatch');
      parseImageReference(image.image);
      result = { path: image.image, commit: image.commit, generation: candidate.generation };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    this.candidates.set(result.path, { repoId: request.repositoryId, commit: result.commit });
    return result;
  }

  isCandidate(reference: string, repoId: string, commit: string): boolean {
    const candidate = this.candidates.get(reference);
    return !!candidate && candidate.repoId === repoId && candidate.commit === commit;
  }

  release(reference: string): void {
    this.candidates.delete(reference);
  }

  async healthy(request: IndexRequest, reference: string, commit: string): Promise<boolean> {
    try {
      parseImageReference(reference);
    } catch {
      return false;
    }
    if (!/^[0-9a-f]{40,64}$/.test(commit)) return false;
    // A failed controller or authorization is not proof that the image is absent.
    await this.graph.withQuery((explore) =>
      explore(reference, 'repository overview', undefined, { repoId: request.repositoryId, commit }),
    );
    return true;
  }
}
