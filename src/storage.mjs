import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createEncryptedStore } from './storage-core.mjs';
export { tokenHash } from './storage-core.mjs';
export function createStore(path, key) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, token TEXT NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, order_id TEXT NOT NULL);',
  );
  return createEncryptedStore(
    {
      close: () => db.close(),
      prepare: (sql) => db.prepare(sql),
      transaction(fn) {
        db.exec('BEGIN IMMEDIATE');
        try {
          const result = fn();
          db.exec('COMMIT');
          return result;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      },
    },
    key,
  );
}
