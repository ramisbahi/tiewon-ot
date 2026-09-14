import { UPSERT_GAME } from './history-sql';
import { env } from 'cloudflare:workers';
import type { Snapshot } from './history';
import { backfills } from './backfills';

let backfillReady: Promise<void> | undefined;
async function ensureArchive() {
  if (!backfillReady) backfillReady = saveSnapshots(Object.values(backfills).map(samples => samples.at(-1)!))
    .catch(error => { backfillReady = undefined; throw error; });
  await backfillReady;
}
const seededGames = new Map<string, Promise<void>>();
async function ensureGame(gameId: string) {
  if (!backfills[gameId]) return;
  if (!seededGames.has(gameId)) seededGames.set(gameId, (async () => {
    const { DB } = historyEnvironment();
    const row = await DB.prepare('SELECT COUNT(*) AS n FROM snapshots WHERE game_id=? AND id LIKE ?')
      .bind(gameId, `${gameId}:replay:%`).first<{ n: number }>();
    if (Number(row?.n) < backfills[gameId].length) await saveSnapshots(backfills[gameId]);
  })().catch(error => { seededGames.delete(gameId); throw error; }));
  await seededGames.get(gameId);
}

export function historyEnvironment() {
  return env as unknown as { DB: D1Database; HISTORY_INGEST_SECRET?: string };
}
export async function saveSnapshots(samples: Snapshot[]) {
  const { DB } = historyEnvironment();
  if (!DB) throw new Error('History storage unavailable');
  // Each batch is bounded below D1's statement/bind limits, and retries are idempotent.
  for (let offset = 0; offset < samples.length; offset += 40) {
    const queries = samples.slice(offset, offset + 40).flatMap(s => [
      DB.prepare('INSERT OR IGNORE INTO snapshots (id, game_id, observed_at, payload) VALUES (?, ?, ?, ?)').bind(s.id, s.gameId, s.observedAt, JSON.stringify(s)),
      DB.prepare(UPSERT_GAME).bind(s.gameId, s.observedAt, JSON.stringify(s.game), s.probabilities.overtime, s.probabilities.finalTie),
    ]);
    if (queries.length) await DB.batch(queries);
  }
}
export async function recentGames() {
  await ensureArchive();
  const { DB } = historyEnvironment();
  const result = await DB.prepare('SELECT * FROM games ORDER BY updated_at DESC LIMIT 64').all<{id: string; updated_at: number; state: string; overtime: number | null; final_tie: number | null}>();
  return result.results.map(row => ({ game: JSON.parse(row.state), probabilities: { overtime: row.overtime, finalTie: row.final_tie }, updatedAt: row.updated_at }));
}
export async function gameSnapshots(gameId: string) {
  await ensureGame(gameId);
  const { DB } = historyEnvironment();
  const result = await DB.prepare('SELECT payload FROM snapshots WHERE game_id=? ORDER BY observed_at, rowid LIMIT 5000').bind(gameId).all<{payload: string}>();
  const seenFinals = new Set<string>();
  return result.results.map(row => JSON.parse(row.payload) as Snapshot).filter(s => {
    if (s.game.isLive) return true;
    const key = `${s.game.homeScore}:${s.game.awayScore}`;
    if (seenFinals.has(key)) return false;
    seenFinals.add(key); return true;
  });
}
