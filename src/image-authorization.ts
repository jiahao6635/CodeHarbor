import type { ImageDigest } from './image-codegraph.js';
import type { ImageIndexPipeline } from './image-indexer.js';
import type { StoreBackend } from './store.js';

/** The controller may serve only a published version or the active worker's candidate. */
export function imageAuthorization(store: StoreBackend, pipeline: ImageIndexPipeline) {
  return async (digest: ImageDigest, repoId: string, commit: string): Promise<boolean> => {
    const reference = `oci://${digest}`;
    const repository = await store.getRepository(repoId);
    if (!repository || repository.status === 'disabled') return false;
    if (repository.path === reference && repository.commit === commit) return true;
    if (repository.status === 'branch_deleted' || !pipeline.isCandidate(reference, repoId, commit)) return false;
    const owner = await store.getUser(repository.sync_owner);
    if (
      !owner ||
      repository.sync_credential_version === 0 ||
      owner.credential_version !== repository.sync_credential_version
    )
      return false;
    return (await store.listJobs(repoId)).some((job) => job.status === 'running');
  };
}
