import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Library } from '../lib/library.ts';
import { emptyLibrary } from '../lib/library.ts';

type AccessRequest = { userId: string; at: number };

// Only this class writes the database, so its TEXT columns are read back as strings.
export class Store {
  declare db: DatabaseSync;

  // A read-only store serves a process that only looks while another one writes: it creates nothing and takes no lock.
  constructor(path: string, { readOnly = false }: { readOnly?: boolean } = {}) {
    if (readOnly) {
      this.db = new DatabaseSync(path, { readOnly: true });
      this.db.exec('PRAGMA busy_timeout=5000');
      return;
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS libraries (user_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  // Trust boundary: only the version is checked, and the payload is taken as library format v1.
  read(userId: string | number): Library {
    const row = this.db.prepare('SELECT payload FROM libraries WHERE user_id = ?').get(String(userId));
    const state: Library = row ? JSON.parse(row.payload as string) : emptyLibrary();
    if (state.version !== 1) throw new Error('Unsupported library version');
    return state;
  }
  mutate<T>(userId: string | number, fn: (state: Library) => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.read(userId);
      const result = fn(state);
      this.db.prepare('INSERT INTO libraries VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload')
        .run(String(userId), JSON.stringify(state));
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  offset(value?: number) {
    if (value !== undefined) this.db.prepare("INSERT INTO metadata VALUES ('offset', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(value));
    const row = this.db.prepare("SELECT value FROM metadata WHERE key='offset'").get();
    return row ? Number(row.value) : undefined;
  }
  requestAccess(userId: string) {
    if (!/^\d+$/.test(userId)) return;
    const row = this.db.prepare("SELECT value FROM metadata WHERE key='access_requests'").get();
    const pending: AccessRequest[] = row ? JSON.parse(row.value as string) : [];
    const next = [...pending.filter(item => item.userId !== userId), { userId, at: Date.now() }].slice(-100);
    this.db.prepare("INSERT INTO metadata VALUES ('access_requests', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(next));
  }
  recover() {
    // No model or Telegram write is retried automatically after process death.
    for (const { user_id } of this.db.prepare('SELECT user_id FROM libraries').all()) {
      this.mutate(user_id as string, state => {
        if (state.job) { state.job = null; state.interrupted = true; }
      });
    }
  }
  close() { this.db.close(); }
}
