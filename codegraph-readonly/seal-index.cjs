// Run only after indexing has finished and all index writers have exited.
// The immutable image must contain a complete standalone SQLite database.
const { lstatSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const root = resolve(process.argv[2] || '/workspace/repo');
const dbPath = join(root, '.codegraph', 'codegraph.db');
for (const path of [root, join(root, '.codegraph'), dbPath]) {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new Error('Index path must not be a symbolic link');
}
const db = new DatabaseSync(dbPath, { open: true });
try {
  const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  if (checkpoint.busy !== 0) throw new Error('Index checkpoint is busy');
  const mode = db.prepare('PRAGMA journal_mode=DELETE').get().journal_mode;
  if (mode !== 'delete') throw new Error('Cannot seal index journal mode');
  const result = db.prepare('PRAGMA quick_check').get().quick_check;
  if (result !== 'ok') throw new Error('Index integrity check failed');
} finally {
  db.close();
}
