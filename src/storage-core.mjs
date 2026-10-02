import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
export const tokenHash = (t) => createHash('sha256').update(t).digest('hex');
export function createEncryptedStore(db, key) {
  if (!/^[a-f0-9]{64}$/.test(key ?? '')) throw Error('Private encryption key required');
  const enc = (id, value) => {
    const iv = randomBytes(12),
      c = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
    c.setAAD(Buffer.from(id));
    const bytes = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), bytes]).toString('base64');
  };
  const dec = (id, value) => {
    const bytes = Buffer.from(value, 'base64'),
      c = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), bytes.subarray(0, 12));
    c.setAAD(Buffer.from(id));
    c.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([c.update(bytes.subarray(28)), c.final()]).toString());
  };
  return {
    close: () => db.close(),
    all: () =>
      db
        .prepare('SELECT id,data FROM orders')
        .all()
        .map((r) => dec(r.id, r.data)),
    get(id) {
      const r = db.prepare('SELECT data FROM orders WHERE id=?').get(id);
      return r ? dec(id, r.data) : undefined;
    },
    authorized(id, token) {
      const r = db
        .prepare('SELECT data FROM orders WHERE id=? AND token=?')
        .get(id, tokenHash(token));
      return r ? dec(id, r.data) : undefined;
    },
    insert(order, token) {
      db.prepare('INSERT INTO orders VALUES(?,?,?)').run(
        order.id,
        tokenHash(token),
        enc(order.id, order),
      );
    },
    update(id, fn) {
      return db.transaction(() => {
        const order = this.get(id);
        if (!order) throw Error('Order missing');
        const result = fn(order);
        db.prepare('UPDATE orders SET data=? WHERE id=?').run(enc(id, order), id);
        return result;
      });
    },
    claimReceipts(id, receipts) {
      return db.transaction(() => {
        for (const r of receipts) {
          const key = `${r.txid.toLowerCase()}/${r.pool}/${r.outputIndex}`;
          const old = db.prepare('SELECT order_id FROM receipts WHERE id=?').get(key);
          if (old && old.order_id !== id) throw Error('Receipt already assigned');
          db.prepare('INSERT OR IGNORE INTO receipts VALUES(?,?)').run(key, id);
        }
      });
    },
  };
}
