import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BotConfig } from './config';
import type { Post, PreviousPost } from './policy';

export class Store {
  private db: DatabaseSync;
  constructor(path: string, mode: 'live' | 'dry-run') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS posts (
        key TEXT PRIMARY KEY, game_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
        probability REAL NOT NULL, created_at INTEGER NOT NULL,
        status TEXT NOT NULL, tweet_id TEXT, error TEXT
      );
      CREATE INDEX IF NOT EXISTS posts_game ON posts(game_id, created_at);`);
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?, ?)').run('mode', mode);
    if (this.setting('mode') !== mode) {
      this.db.close();
      throw new Error('Database mode mismatch: live and dry-run must use separate databases');
    }
  }
  close() { this.db.close(); }
  setting(key: string) {
    return (this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined)?.value;
  }
  pauseUntil(time: number) {
    this.db.prepare('INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('pause_until', String(time));
  }
  blocked(now: number) {
    return Number(this.setting('pause_until') || 0) > now
      || Boolean(this.db.prepare("SELECT key FROM posts WHERE status IN ('sending', 'uncertain') LIMIT 1").get());
  }
  previous(gameId: string) {
    return this.db.prepare("SELECT probability, created_at, kind FROM posts WHERE game_id=? AND status='sent' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(gameId) as PreviousPost | undefined;
  }
  count(gameId: string) {
    return Number(this.db.prepare("SELECT COUNT(*) AS n FROM posts WHERE game_id=? AND status!='rejected'").get(gameId)!.n);
  }
  claim(post: Post, config: BotConfig, now: number) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.blocked(now)) return false;
      const dayStart = Math.floor(now / 86400_000) * 86400_000;
      const daily = Number(this.db.prepare("SELECT COUNT(*) AS n FROM posts WHERE created_at>=? AND status!='rejected'").get(dayStart)!.n);
      if (daily >= config.maxPostsPerDay || this.count(post.gameId) >= config.maxPostsPerGame) return false;
      const previous = this.previous(post.gameId);
      if (post.kind === 'forecast' && (this.count(post.gameId) >= config.maxPostsPerGame - 1 || previous && (previous.kind !== 'forecast' || now - previous.created_at < config.cooldownSeconds * 1000))) return false;
      const inserted = this.db.prepare(`INSERT INTO posts (key, game_id, kind, text, probability, created_at, status)
        VALUES (?, ?, ?, ?, ?, ?, 'sending') ON CONFLICT(key) DO UPDATE SET status='sending', created_at=excluded.created_at, error=NULL
        WHERE posts.status='rejected'`).run(post.key, post.gameId, post.kind, post.text, post.probability, now);
      return inserted.changes === 1;
    } finally { this.db.exec('COMMIT'); }
  }
  sent(key: string, tweetId: string) {
    this.db.prepare("UPDATE posts SET status='sent', tweet_id=?, error=NULL WHERE key=?").run(tweetId, key);
  }
  failed(key: string, status: 'uncertain' | 'rejected', error: string) {
    this.db.prepare('UPDATE posts SET status=?, error=? WHERE key=?').run(status, error, key);
  }
  history() {
    return this.db.prepare('SELECT key, kind, status, text, tweet_id, error, created_at FROM posts ORDER BY created_at DESC LIMIT 50').all();
  }
  resolve(key: string, result: string) {
    if (result !== 'not-sent' && !/^\d+$/.test(result)) throw new Error('Resolution must be an X post ID or not-sent');
    const row = this.db.prepare("SELECT status FROM posts WHERE key=? AND status IN ('sending','uncertain')").get(key);
    if (!row) throw new Error('No unresolved post with this key');
    if (result === 'not-sent') this.failed(key, 'rejected', 'Operator confirmed no post was published');
    else this.sent(key, result);
  }
}
