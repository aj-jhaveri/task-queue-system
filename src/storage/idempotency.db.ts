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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS idempotency_records (
        key TEXT PRIMARY KEY,
        job_name TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    logger.info('Idempotency database initialized successfully');
  }

  public getRecord(key: string): IdempotencyRecord | undefined {
    const stmt = this.db.prepare<[string], IdempotencyRecord>(
      'SELECT key, job_name, status, result_json, created_at FROM idempotency_records WHERE key = ?'
    );
    return stmt.get(key);
  }

  public hasBeenProcessed(key: string): boolean {
    const record = this.getRecord(key);
    return record !== undefined && record.status === 'COMPLETED';
  }

  public recordSuccess(key: string, jobName: string, result: Record<string, unknown>): void {
    const stmt = this.db.prepare(`
      INSERT INTO idempotency_records (key, job_name, status, result_json, created_at)
      VALUES (?, ?, 'COMPLETED', ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        status = 'COMPLETED',
        result_json = excluded.result_json,
        created_at = excluded.created_at
    `);
    stmt.run(key, jobName, JSON.stringify(result), new Date().toISOString());
  }

  public recordFailure(key: string, jobName: string, error: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO idempotency_records (key, job_name, status, result_json, created_at)
      VALUES (?, ?, 'FAILED', ?, ?)
      ON CONFLICT(key) DO UPDATE SET
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
