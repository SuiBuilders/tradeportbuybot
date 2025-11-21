import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

let db: Database.Database | null = null;

export function initDb(dbPath: string): Database.Database {
  if (db) return db;

  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  runMigrations(db);
  return db;
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb first.');
  }
  return db;
}

function runMigrations(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chat_configs (
      chat_id INTEGER PRIMARY KEY,
      token_type TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      token_decimals INTEGER NOT NULL,
      min_alert_amount_raw TEXT NOT NULL,
      emoji TEXT NOT NULL,
      emoji_step_amount_raw TEXT NOT NULL,
      max_emoji_repeat INTEGER NOT NULL,
      header_media_file_id TEXT NULL,
      header_media_type TEXT NULL,
      created_by_user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}
