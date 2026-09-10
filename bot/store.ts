import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BotConfig } from './config';
import type { Post } from './policy';
import { EMPTY_HISTORY, type BotGame, type GameHistory } from './types';
import { snapshot, type Snapshot } from '../web/lib/history';
import type { Probabilities } from '../web/lib/live-probabilities';

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
        status TEXT NOT NULL, tweet_id TEXT, error TEXT, milestone REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS posts_game ON posts(game_id, created_at);
      CREATE TABLE IF NOT EXISTS observations (
        game_id TEXT PRIMARY KEY, observed_at INTEGER NOT NULL, phase TEXT NOT NULL,
        probability REAL, state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, observed_at INTEGER NOT NULL, payload TEXT NOT NULL, uploaded INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS idx_snapshots_pending ON snapshots(uploaded, observed_at);`);
    // Upgrade pre-milestone deployments without losing posting history.
    const columns = this.db.prepare('PRAGMA table_info(posts)').all();
    if (!columns.some((column) => column.name === 'milestone')) this.db.exec('ALTER TABLE posts ADD COLUMN milestone REAL NOT NULL DEFAULT 0');
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
  gameHistory(gameId: string): GameHistory {
    const rows = this.db.prepare("SELECT kind, milestone, tweet_id FROM posts WHERE game_id=? AND status='sent' ORDER BY created_at, rowid").all(gameId);
    const history = { ...EMPTY_HISTORY };
    for (const row of rows) {
      history.followed = true;
      if (row.kind === 'q4_threshold') history.q4Milestone = Math.max(history.q4Milestone, Number(row.milestone));
      if (row.kind === 'ot_threshold' || row.kind === 'overtime') history.otMilestone = Math.max(history.otMilestone, Number(row.milestone));
      if (row.kind === 'overtime') history.overtimeAnnounced = true;
      if (row.kind === 'final') history.finalized = true;
      if (row.tweet_id && /^\d+$/.test(String(row.tweet_id))) history.lastTweetId = String(row.tweet_id);
    }
    return history;
  }
  observe(game: BotGame, probabilities: Probabilities, now: number) {
    if (game.source !== 'live') return;
    const probability = game.quarter > 4 ? probabilities.finalTie : probabilities.overtime;
    this.db.prepare(`INSERT INTO observations VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(game_id) DO UPDATE SET observed_at=excluded.observed_at, phase=excluded.phase,
      probability=excluded.probability, state=excluded.state`).run(game.id, now,
        !game.isLive ? 'final' : game.quarter > 4 ? 'final_tie' : 'overtime', probability, JSON.stringify(game));
    const sample = snapshot(game, probabilities, now);
    this.db.prepare('INSERT OR IGNORE INTO snapshots (id, observed_at, payload) VALUES (?, ?, ?)').run(sample.id, now, JSON.stringify(sample));
  }
  pendingSnapshots(): Snapshot[] {
    return this.db.prepare('SELECT payload FROM snapshots WHERE uploaded=0 ORDER BY observed_at LIMIT 100').all().map(row => JSON.parse(String(row.payload)));
  }
  uploaded(ids: string[]) {
    this.db.exec('BEGIN IMMEDIATE');
    try { for (const id of ids) this.db.prepare('UPDATE snapshots SET uploaded=1 WHERE id=?').run(id); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  observations() { return this.db.prepare('SELECT * FROM observations ORDER BY observed_at DESC LIMIT 50').all(); }
  claim(post: Post, config: BotConfig, now: number) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const claim = () => {
        if (this.blocked(now)) return false;
        const history = this.gameHistory(post.gameId);
        if (history.finalized) return false;
        if (post.kind === 'q4_threshold' && (history.overtimeAnnounced || history.q4Milestone >= (post.milestone ?? 0))) return false;
        if (post.kind === 'ot_threshold' && history.otMilestone >= (post.milestone ?? 0)) return false;
        if (post.kind === 'overtime' && history.overtimeAnnounced) return false;
        // Outcome alerts have reserved access: forecast volume must never suppress OT/finals.
        if (!['overtime', 'final'].includes(post.kind)) {
          const dayStart = Math.floor(now / 86400_000) * 86400_000;
          const daily = Number(this.db.prepare("SELECT COUNT(*) AS n FROM posts WHERE created_at>=? AND status!='rejected' AND kind NOT IN ('overtime','final')").get(dayStart)!.n);
          if (daily >= config.maxForecastsPerDay) return false;
        }
        // Re-read the parent under the same transaction that claims the send.
        post.replyTo = history.lastTweetId;
        const inserted = this.db.prepare(`INSERT INTO posts (key, game_id, kind, text, probability, created_at, status, milestone)
          VALUES (?, ?, ?, ?, ?, ?, 'sending', ?) ON CONFLICT(key) DO UPDATE SET status='sending', created_at=excluded.created_at,
          text=excluded.text, probability=excluded.probability, milestone=excluded.milestone, error=NULL
          WHERE posts.status='rejected'`).run(post.key, post.gameId, post.kind, post.text, post.probability ?? -1, now, post.milestone ?? 0);
        return inserted.changes === 1;
      };
      const result = claim();
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  sent(key: string, tweetId: string) {
    this.db.prepare("UPDATE posts SET status='sent', tweet_id=?, error=NULL WHERE key=?").run(tweetId, key);
  }
  failed(key: string, status: 'uncertain' | 'rejected', error: string) {
    this.db.prepare('UPDATE posts SET status=?, error=? WHERE key=?').run(status, error, key);
  }
  history() {
    return this.db.prepare('SELECT key, kind, milestone, status, text, tweet_id, error, created_at FROM posts ORDER BY created_at DESC LIMIT 50').all();
  }
  resolve(key: string, result: string) {
    if (result !== 'not-sent' && !/^\d+$/.test(result)) throw new Error('Resolution must be an X post ID or not-sent');
    const row = this.db.prepare("SELECT status FROM posts WHERE key=? AND status IN ('sending','uncertain')").get(key);
    if (!row) throw new Error('No unresolved post with this key');
    if (result === 'not-sent') this.failed(key, 'rejected', 'Operator confirmed no post was published');
    else this.sent(key, result);
  }
}
