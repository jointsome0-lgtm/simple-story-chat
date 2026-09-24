import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, chmodSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Library } from '../lib/library.ts';
import { emptyLibrary } from '../lib/library.ts';

type AccessRequest = { userId: string; at: number };

// Only this class writes the database, so its TEXT columns are read back as strings.
export class Store {
  declare db: DatabaseSync;
  declare path: string;
  // The portrait files written inside the write under way (`writePortrait`), which a rollback takes with it.
  declare writing: string[] | undefined;

  // A read-only store serves a process that only looks while another one writes: it creates nothing and takes no lock.
  constructor(path: string, { readOnly = false }: { readOnly?: boolean } = {}) {
    this.path = path;
    if (readOnly) {
      this.db = new DatabaseSync(path, { readOnly: true });
      this.db.exec('PRAGMA busy_timeout=5000');
      return;
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    // The key that names each reader's directory of portraits (`portraits`) is made with the database, so that no
    // write which is rolled back can take it with it and leave a directory nobody can find.
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS libraries (user_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO metadata VALUES ('portrait_key', lower(hex(randomblob(32))));`);
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
    const written: string[] = this.writing = [];
    try {
      const state = this.read(userId);
      const result = fn(state);
      this.db.prepare('INSERT INTO libraries VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload')
        .run(String(userId), JSON.stringify(state));
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); }
      // A file that cannot go now goes with the next sweep, and never hides why the write failed.
      finally { for (const file of written) try { rmSync(file, { force: true }); } catch {} }
      throw error;
    } finally { this.writing = undefined; }
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
      // A portrait file that cannot go now goes with a later sweep; it never keeps the bot from starting.
      try { this.sweepPortraits(user_id as string); } catch {}
    }
  }
  // The portraits a reader kept (local/picture.ts) are PNG files beside the database, never in it: one directory for
  // each reader, named by a keyed hash of their id, and a random name for each file, so that no path says whose it
  // is or whom it shows. The library refers to a file by that name alone. A file is written before the library write
  // that refers to it, and `sweepPortraits` deletes every file of a reader's that their library does not refer to —
  // a portrait replaced, one whose story is deleted, and one whose write was rolled back or never came.
  portraits(userId: string) {
    if (this.path === ':memory:') throw new Error('Portraits need a database file to sit beside');
    const key = this.db.prepare("SELECT value FROM metadata WHERE key='portrait_key'").get()!.value as string;
    return join(`${this.path}.portraits`, createHmac('sha256', key).update(userId).digest('hex').slice(0, 32));
  }
  // Writes one portrait of `userId`'s and returns the name the library is to refer to it by. Inside a write, a rollback
  // of that write deletes the file again (`mutate`).
  writePortrait(userId: string, bytes: Uint8Array): string {
    const directory = this.portraits(userId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = `${randomBytes(16).toString('hex')}.png`;
    writeFileSync(join(directory, file), bytes, { mode: 0o600, flag: 'wx' });
    this.writing?.push(join(directory, file));
    return file;
  }
  // Called once a write that may have let a portrait go is committed, never inside one. Returns how many files went.
  sweepPortraits(userId: string): number {
    if (this.path === ':memory:') return 0;
    const directory = this.portraits(userId);
    let files: string[];
    try { files = readdirSync(directory); } catch { return 0; }
    const kept = new Set(Object.values(this.read(userId).stories).flatMap(story => (story.sheet ?? []).map(one => one?.portrait?.file)));
    const lost = files.filter(file => !kept.has(file));
    for (const file of lost) rmSync(join(directory, file), { force: true });
    return lost.length;
  }
  close() { this.db.close(); }
}
