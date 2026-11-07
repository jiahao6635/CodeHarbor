import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMigrationArgs } from '../src/migrate-sqlite.js';

test('offline migration requires explicit source and confirmation', () => {
  assert.match(parseMigrationArgs(['--source', './state.sqlite', '--confirm-source-offline']), /state\.sqlite$/);
  assert.throws(() => parseMigrationArgs(['--source', './state.sqlite']), /Usage/);
  assert.throws(() => parseMigrationArgs(['--source', '--confirm-source-offline', '--confirm-source-offline']), /Usage/);
  assert.throws(() => parseMigrationArgs(['--source', './state.sqlite', '--confirm-source-offline', 'extra']), /Usage/);
});
