import { Store } from './store.js';

type Methods = Exclude<keyof Store, 'transaction' | 'transactionAsync' | 'close'>;
type AsyncMethod<T> = T extends (...args: infer A) => infer R ? (...args: A) => Promise<R> : never;
/** Transaction callbacks must exclusively use the supplied tx object. */
export type StoreAccess = { [K in Methods]: AsyncMethod<Store[K]> };
export type StoreBackend = StoreAccess & {
  transaction<T>(fn: (tx: StoreAccess) => Promise<T>): Promise<T>;
  checkHealth(): Promise<void>;
  close(): Promise<void>;
};

type Run = <T>(operation: () => T | Promise<T>) => Promise<T>;

function sqliteAccess(store: Store, run: Run): StoreAccess {
  return {
    createUser: (...a) => run(() => store.createUser(...a)),
    getUser: (...a) => run(() => store.getUser(...a)),
    updateUserCredential: (...a) => run(() => store.updateUserCredential(...a)),
    createKey: (...a) => run(() => store.createKey(...a)),
    getKey: (...a) => run(() => store.getKey(...a)),
    listKeys: (...a) => run(() => store.listKeys(...a)),
    revokeKey: (...a) => run(() => store.revokeKey(...a)),
    revokeUserKeys: (...a) => run(() => store.revokeUserKeys(...a)),
    createRepository: (...a) => run(() => store.createRepository(...a)),
    getRepository: (...a) => run(() => store.getRepository(...a)),
    getRepositoryByCodeupId: (...a) => run(() => store.getRepositoryByCodeupId(...a)),
    listRepositories: (...a) => run(() => store.listRepositories(...a)),
    updateRepository: (...a) => run(() => store.updateRepository(...a)),
    deleteRepository: (...a) => run(() => store.deleteRepository(...a)),
    createJob: (...a) => run(() => store.createJob(...a)),
    getJob: (...a) => run(() => store.getJob(...a)),
    listJobs: (...a) => run(() => store.listJobs(...a)),
    listPendingJobs: (...a) => run(() => store.listPendingJobs(...a)),
    updateJob: (...a) => run(() => store.updateJob(...a)),
  };
}

/** Serializes SQLite transactions and individual calls on one connection. */
export class AsyncSqliteStore implements StoreBackend {
  private tail: Promise<void> = Promise.resolve();
  private readonly db: Store;
  private readonly access: StoreAccess;
  constructor(path: string | Store) {
    this.db = typeof path === 'string' ? new Store(path) : path;
    this.access = sqliteAccess(this.db, op => this.serialize(op));
  }
  private async serialize<T>(op: () => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await op(); } finally { release(); }
  }
  createUser: StoreAccess['createUser'] = (...a) => this.access.createUser(...a);
  getUser: StoreAccess['getUser'] = (...a) => this.access.getUser(...a);
  updateUserCredential: StoreAccess['updateUserCredential'] = (...a) => this.access.updateUserCredential(...a);
  createKey: StoreAccess['createKey'] = (...a) => this.access.createKey(...a);
  getKey: StoreAccess['getKey'] = (...a) => this.access.getKey(...a);
  listKeys: StoreAccess['listKeys'] = (...a) => this.access.listKeys(...a);
  revokeKey: StoreAccess['revokeKey'] = (...a) => this.access.revokeKey(...a);
  revokeUserKeys: StoreAccess['revokeUserKeys'] = (...a) => this.access.revokeUserKeys(...a);
  createRepository: StoreAccess['createRepository'] = (...a) => this.access.createRepository(...a);
  getRepository: StoreAccess['getRepository'] = (...a) => this.access.getRepository(...a);
  getRepositoryByCodeupId: StoreAccess['getRepositoryByCodeupId'] = (...a) => this.access.getRepositoryByCodeupId(...a);
  listRepositories: StoreAccess['listRepositories'] = (...a) => this.access.listRepositories(...a);
  updateRepository: StoreAccess['updateRepository'] = (...a) => this.access.updateRepository(...a);
  deleteRepository: StoreAccess['deleteRepository'] = (...a) => this.access.deleteRepository(...a);
  createJob: StoreAccess['createJob'] = (...a) => this.access.createJob(...a);
  getJob: StoreAccess['getJob'] = (...a) => this.access.getJob(...a);
  listJobs: StoreAccess['listJobs'] = (...a) => this.access.listJobs(...a);
  listPendingJobs: StoreAccess['listPendingJobs'] = (...a) => this.access.listPendingJobs(...a);
  updateJob: StoreAccess['updateJob'] = (...a) => this.access.updateJob(...a);
  transaction<T>(fn: (tx: StoreAccess) => Promise<T>): Promise<T> {
    return this.serialize(() => this.db.transactionAsync(() => fn(sqliteAccess(this.db, async op => op()))));
  }
  checkHealth(): Promise<void> { return this.serialize(() => { this.db.getUser('health-check'); }); }
  close(): Promise<void> { return this.serialize(() => this.db.close()); }
}
