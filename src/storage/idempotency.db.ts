import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config/environment.js';
import { logger } from '../logging/logger.js';

export interface IdempotencyRecord {
  key: string;
  job_name: string;
  status: 'COMPLETED' | 'FAILED';
  result_json: string;
  created_at: string;
}

export class IdempotencyDatabase {
  private db: Database.Database;

  constructor(dbPath: string = config.SQLITE_DB_PATH) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.init();
  }

  private init(): void {
    this.migrateIfLegacySchema();

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS idempotency_records (
        job_name TEXT NOT NULL,
        key TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (job_name, key)
      );
    `);
    logger.info('Idempotency database initialized successfully');
  }

  /**
   * Rebuilds the table if it still carries the legacy `key TEXT PRIMARY KEY`.
   *
   * CREATE TABLE IF NOT EXISTS does not alter an existing table, so without
   * this an already-deployed database would keep the single-column key - and
   * with it the cross-job-type collision the composite key exists to prevent.
   * The demo runs on an ephemeral filesystem and would have self-healed on the
   * next redeploy, but relying on that silently is exactly the reasoning this
   * repo argues against elsewhere.
   *
   * Existing rows already carry job_name, so they migrate without loss. A
   * collision during the copy is possible in principle (two rows sharing a key
   * across job types) but not in practice, because the legacy PRIMARY KEY made
   * such a pair unstorable in the first place.
   */
  private migrateIfLegacySchema(): void {
    const existing = this.db
      .prepare<[], { sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'idempotency_records'`
      )
      .get();

    if (!existing) return;
    if (existing.sql.includes('PRIMARY KEY (job_name, key)')) return;

    logger.warn('Legacy idempotency schema detected (single-column key); migrating to composite (job_name, key)');

    this.db.exec(`
      BEGIN;
      ALTER TABLE idempotency_records RENAME TO idempotency_records_legacy;
      CREATE TABLE idempotency_records (
        job_name TEXT NOT NULL,
        key TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (job_name, key)
      );
      INSERT OR IGNORE INTO idempotency_records (job_name, key, status, result_json, created_at)
        SELECT job_name, key, status, result_json, created_at FROM idempotency_records_legacy;
      DROP TABLE idempotency_records_legacy;
      COMMIT;
    `);

    logger.info('Idempotency schema migration complete');
  }

  public getRecord(jobName: string, key: string): IdempotencyRecord | undefined {
    const stmt = this.db.prepare<[string, string], IdempotencyRecord>(
      `SELECT key, job_name, status, result_json, created_at
         FROM idempotency_records
        WHERE job_name = ? AND key = ?`
    );
    return stmt.get(jobName, key);
  }

  /**
   * Idempotency is scoped to (job_name, key), never to key alone.
   *
   * Clients choose their own idempotency keys, and nothing stops the same
   * business identifier - an order id, say - being reused across job types.
   * The producer already prefixes BullMQ jobIds by type, so an email job and a
   * webhook job sharing a key are two distinct jobs that both enqueue and both
   * reach a processor. If this lookup ignored job_name, the second one would
   * find the first one's COMPLETED record, short-circuit before its side-effect,
   * and report success for work it never performed.
   */
  public hasBeenProcessed(jobName: string, key: string): boolean {
    const record = this.getRecord(jobName, key);
    return record !== undefined && record.status === 'COMPLETED';
  }

  public recordSuccess(key: string, jobName: string, result: Record<string, unknown>): void {
    const stmt = this.db.prepare(`
      INSERT INTO idempotency_records (key, job_name, status, result_json, created_at)
      VALUES (?, ?, 'COMPLETED', ?, ?)
      ON CONFLICT(job_name, key) DO UPDATE SET
        status = 'COMPLETED',
        result_json = excluded.result_json,
        created_at = excluded.created_at
    `);
    stmt.run(key, jobName, JSON.stringify(result), new Date().toISOString());
  }

  /**
   * Records a terminal failure - one that exhausted every retry attempt.
   *
   * Called from the worker's `failed` handler only when attemptsMade has
   * reached maxAttempts, immediately before DLQ routing. Recording per-attempt
   * would mark a job FAILED while a retry is still pending, which would make
   * the record actively misleading.
   */
  public recordFailure(key: string, jobName: string, error: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO idempotency_records (key, job_name, status, result_json, created_at)
      VALUES (?, ?, 'FAILED', ?, ?)
      ON CONFLICT(job_name, key) DO UPDATE SET
        status = 'FAILED',
        result_json = excluded.result_json,
        created_at = excluded.created_at
    `);
    stmt.run(key, jobName, JSON.stringify({ error }), new Date().toISOString());
  }

  public clearAll(): void {
    this.db.exec('DELETE FROM idempotency_records;');
  }

  public close(): void {
    this.db.close();
  }
}

export const idempotencyDb = new IdempotencyDatabase();
