import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { IdempotencyDatabase } from '../src/storage/idempotency.db.js';

/**
 * Schema migration guard.
 *
 * `CREATE TABLE IF NOT EXISTS` does not alter an existing table, so a database
 * created before the composite key would silently keep `key TEXT PRIMARY KEY`
 * - and with it the cross-job-type collision that loses webhook deliveries.
 * The demo's filesystem is ephemeral and would self-heal on redeploy, but a
 * correctness guarantee that depends on the host wiping the disk is not a
 * guarantee. These tests cover the migration that makes it one.
 */

const tempFiles: string[] = [];

function legacyDbPath(): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'idem-')), 'legacy.db');
  tempFiles.push(p);
  return p;
}

/** Creates a database carrying the pre-migration single-column schema. */
function seedLegacy(dbPath: string, rows: Array<[string, string, string]>): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE idempotency_records (
      key TEXT PRIMARY KEY,
      job_name TEXT NOT NULL,
      status TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const stmt = db.prepare(
    `INSERT INTO idempotency_records (key, job_name, status, result_json, created_at)
     VALUES (?, ?, 'COMPLETED', ?, ?)`
  );
  for (const [key, jobName, payload] of rows) {
    stmt.run(key, jobName, payload, new Date().toISOString());
  }
  db.close();
}

afterEach(() => {
  for (const f of tempFiles.splice(0)) {
    try {
      fs.rmSync(path.dirname(f), { recursive: true, force: true });
    } catch {
      /* temp dir cleanup is best-effort */
    }
  }
});

describe('Legacy schema migration', () => {
  it('rewrites a single-column key table to the composite primary key', () => {
    const dbPath = legacyDbPath();
    seedLegacy(dbPath, []);

    new IdempotencyDatabase(dbPath).close();

    const db = new Database(dbPath);
    const sql = db
      .prepare<[], { sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='idempotency_records'`
      )
      .get()!.sql;
    db.close();

    expect(sql).toContain('PRIMARY KEY (job_name, key)');
  });

  it('preserves existing records through the migration', () => {
    const dbPath = legacyDbPath();
    seedLegacy(dbPath, [
      ['order_1', 'EMAIL_NOTIFICATION', '{"messageId":"msg_a"}'],
      ['order_2', 'WEBHOOK_DELIVERY', '{"httpStatus":200}'],
    ]);

    const store = new IdempotencyDatabase(dbPath);

    expect(store.hasBeenProcessed('EMAIL_NOTIFICATION', 'order_1')).toBe(true);
    expect(store.getRecord('EMAIL_NOTIFICATION', 'order_1')?.result_json).toContain('msg_a');
    expect(store.hasBeenProcessed('WEBHOOK_DELIVERY', 'order_2')).toBe(true);

    // Scoping now applies to the migrated rows too.
    expect(store.hasBeenProcessed('WEBHOOK_DELIVERY', 'order_1')).toBe(false);
    store.close();
  });

  it('accepts a cross-type key pair the legacy schema could not store', () => {
    const dbPath = legacyDbPath();
    seedLegacy(dbPath, [['order_9', 'EMAIL_NOTIFICATION', '{"messageId":"msg_z"}']]);

    const store = new IdempotencyDatabase(dbPath);
    store.recordSuccess('order_9', 'WEBHOOK_DELIVERY', { httpStatus: 200 });

    expect(store.getRecord('EMAIL_NOTIFICATION', 'order_9')?.result_json).toContain('msg_z');
    expect(store.getRecord('WEBHOOK_DELIVERY', 'order_9')?.result_json).toContain('200');
    store.close();
  });

  it('is idempotent: a second open does not rebuild or lose data', () => {
    const dbPath = legacyDbPath();
    seedLegacy(dbPath, [['order_3', 'EMAIL_NOTIFICATION', '{"messageId":"msg_b"}']]);

    new IdempotencyDatabase(dbPath).close();
    const second = new IdempotencyDatabase(dbPath);

    expect(second.getRecord('EMAIL_NOTIFICATION', 'order_3')?.result_json).toContain('msg_b');
    second.close();
  });

  it('creates the composite schema directly on a fresh database', () => {
    const dbPath = legacyDbPath();

    const store = new IdempotencyDatabase(dbPath);
    store.recordSuccess('k1', 'EMAIL_NOTIFICATION', { a: 1 });
    store.recordSuccess('k1', 'WEBHOOK_DELIVERY', { b: 2 });

    expect(store.hasBeenProcessed('EMAIL_NOTIFICATION', 'k1')).toBe(true);
    expect(store.hasBeenProcessed('WEBHOOK_DELIVERY', 'k1')).toBe(true);
    store.close();
  });
});
