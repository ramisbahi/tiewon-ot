import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../store';
import { publishGames } from '../engine';
import { nextPost, MILESTONES } from '../policy';
import { readConfig } from '../config';
import { EMPTY_HISTORY, type BotGame } from '../types';
import { syncHistory } from '../history-sync';
import { XClient } from '../x-client';
import { reconstructSummary } from '../backfill';
import { botGames, attachOvertimeContext } from '../../web/lib/live-feed';
import { liveProbabilities } from '../../web/lib/live-probabilities';
import { predictFinalTie, resolveOvertimeDrive, type OTFrame } from '../../web/lib/ot-model';
import { snapshot, validSnapshot } from '../../web/lib/history';
import { UPSERT_GAME } from '../../web/lib/history-sql';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8'));
const config = { ...readConfig({}), live: true };
const noop = () => {};
const base: BotGame = {
  id: '401000009', homeTeam: 'SEA', awayTeam: 'NE', homeScore: 10, awayScore: 10,
  quarter: 4, clockSeconds: 60, clockLabel: '1:00', possession: 'away', down: 1, distance: 10,
  yardlineOwn: 25, timeoutsHome: 2, timeoutsAway: 2, phase: 'scrimmage', tryType: 'kick', pendingTryTeam: 'away',
  overtimeRules: 'current_regular', seasonType: 'regular', source: 'live', isLive: true,
  status: 'STATUS_IN_PROGRESS', detail: 'Live', fieldStateReliable: true,
};
const ot: BotGame = { ...base, quarter: 5, clockSeconds: 600, overtime: { completed: { home: 0, away: 0 }, firstPossession: 'away', source: 'espn-drives' } };

test('strict milestone crossings, coalescing, no repeat after dips, and self-thread replies', async () => {
  const store = new Store(':memory:', 'live');
  const sent: { text: string; parent?: string }[] = [];
  const post = async (text: string, parent?: string) => { sent.push({ text, parent }); return String(100 + sent.length); };
  let now = Date.now();
  const poll = (g: BotGame, p: number | null) => publishGames([g], store, config, post, now += 15000, noop, () => ({ overtime: p, finalTie: p }));
  try {
    for (const threshold of MILESTONES) {
      assert.equal(await poll(base, threshold), 0);
      assert.equal(await poll(base, threshold + .001), 1);
      assert.equal(await poll(base, .10), 0);
    }
    assert.equal(sent.length, 4);
    assert.equal(sent[0].parent, undefined);
    assert.equal(sent[3].parent, '103');
    assert.equal(await poll(ot, .10), 1);
    assert.match(sent[4].text, /^OVERTIME!/);
    assert.equal(await poll(ot, .95), 1);
    assert.match(sent[5].text, /20% \/ 50% \/ 75% \/ 90%/);
    assert.equal(await poll(ot, .95), 0);
    assert.equal(await poll({ ...ot, isLive: false }, 1), 1);
    assert.match(sent[6].text, /IT'S A TIE/);
    assert.equal(sent[6].parent, '106');
    assert.equal(await poll({ ...ot, isLive: false }, 1), 0);
    assert.equal(await poll(ot, .99), 0);
    assert.equal(store.gameHistory(base.id).finalized, true);
  } finally { store.close(); }
});

test('forecast budget and unavailable fields cannot suppress confirmed OT or final', async () => {
  const store = new Store(':memory:', 'live'); const limited = { ...config, maxForecastsPerDay: 1 };
  const predict = () => ({ overtime: .95, finalTie: null });
  try {
    assert.equal(await publishGames([base], store, limited, async () => '100', Date.now(), noop, predict), 1);
    assert.equal(await publishGames([{ ...ot, fieldStateReliable: false }], store, limited, async () => '101', Date.now(), noop, predict), 1);
    assert.equal(await publishGames([{ ...ot, isLive: false, homeScore: 13 }], store, limited, async () => '102', Date.now(), noop, predict), 1);
  } finally { store.close(); }
  assert.equal(nextPost({ ...ot, seasonType: 'postseason' }, { ...EMPTY_HISTORY, overtimeAnnounced: true }, .99), null);
});

test('live OT drive rules distinguish first opportunity, equalizing scores, and sudden death', () => {
  const frame = (): OTFrame => ({ scores: { home: 0, away: 0 }, completed: { home: 0, away: 0 }, offense: 'home' });
  let f = frame();
  assert.equal(resolveOvertimeDrive(f, 'Touchdown', 'current_regular', () => 0), false);
  assert.equal(f.scores.home, 7);
  assert.equal(resolveOvertimeDrive(f, 'Touchdown', 'current_regular', () => 0), false);
  assert.equal(resolveOvertimeDrive(f, 'Field goal', 'current_regular', () => 0), true);
  f = frame();
  assert.equal(resolveOvertimeDrive(f, 'Field goal', 'current_regular', () => 0), false);
  assert.equal(resolveOvertimeDrive(f, 'No score', 'current_regular', () => 0), true);
  f = frame();
  assert.equal(resolveOvertimeDrive(f, 'No score', 'current_regular', () => 0), false);
  assert.equal(resolveOvertimeDrive(f, 'Touchdown', 'current_regular', () => 0), true);
  assert.equal(resolveOvertimeDrive(frame(), 'Touchdown', 'legacy_regular', () => 0), true);
  assert.equal(resolveOvertimeDrive(frame(), 'Safety', 'current_regular', () => 0), true);
});

test('OT clock expiry uses actual score and forecasts require possession history', () => {
  assert.ok(predictFinalTie({ ...ot, clockSeconds: 1 })! > .9);
  assert.equal(predictFinalTie({ ...ot, clockSeconds: 1, homeScore: 30 }), 0);
  assert.equal(predictFinalTie({ ...ot, overtime: undefined }), null);
  assert.equal(predictFinalTie({ ...ot, clockSeconds: 0 }), null);
  assert.equal(predictFinalTie({ ...ot, seasonType: 'postseason' }), 0);
  assert.equal(predictFinalTie(ot), predictFinalTie(ot));
  const reg = liveProbabilities(base);
  assert.ok(reg.finalTie! > 0 && reg.finalTie! < reg.overtime!);
  assert.deepEqual(liveProbabilities({ ...ot, isLive: false }), { overtime: 1, finalTie: 1 });
  assert.deepEqual(liveProbabilities({ ...base, isLive: false, homeScore: 13 }), { overtime: 0, finalTie: 0 });
});

test('real ESPN GB-DAL final and replayed second OT possession match current adapter', () => {
  const scoreboard = fixture('gb-dal-2025-scoreboard.json');
  const game = botGames(scoreboard, Date.parse(scoreboard.events[0].date) + 5 * 3600000)[0];
  assert.equal(game.quarter, 5); assert.equal(game.homeScore, 40); assert.equal(game.awayScore, 40); assert.equal(game.isLive, false);
  const summary = fixture('gb-dal-2025-summary.json');
  const current = summary.drives.previous.pop();
  current.plays = current.plays.slice(0, 3);
  const play = current.plays.at(-1);
  summary.drives.current = current;
  summary.header.competitions[0].status.type.completed = false;
  summary.header.competitions[0].competitors.find((c: {homeAway: string}) => c.homeAway === 'away').score = String(play.awayScore);
  const [minutes, seconds] = play.clock.displayValue.split(':').map(Number);
  const live: BotGame = { ...game, isLive: true, homeScore: play.homeScore, awayScore: play.awayScore, possession: 'away',
    fieldStateReliable: true, clockSeconds: minutes * 60 + seconds, phase: 'scrimmage' };
  assert.deepEqual(attachOvertimeContext(live, summary).overtime?.completed, { home: 1, away: 0 });
  assert.equal(attachOvertimeContext({ ...live, awayScore: 99 }, summary).overtime, undefined);
  assert.equal(attachOvertimeContext({ ...live, clockSeconds: 1 }, summary).overtime, undefined);
  summary.drives.previous = [];
  assert.equal(attachOvertimeContext(live, summary).overtime, undefined);
});

test('Patriots-Seahawks backfill uses pre-play scores, historical timeouts, actual wallclocks and confirmed final', () => {
  const summary = fixture('ne-sea-2026-summary.json');
  const points = reconstructSummary(summary);
  assert.equal(points.length, 179);
  assert.ok(points.every(validSnapshot));
  const td = points.find(p => p.playId === '4018726563070')!;
  assert.equal(td.game.homeScore, 3); // TD result is 10; must not leak into this forecast.
  assert.equal(points[points.indexOf(td) + 1].game.homeScore, 10);
  const interception = points.find(p => p.playId === '4018726564006')!;
  assert.equal(interception.game.clockSeconds, 26);
  assert.equal(interception.game.yardlineOwn, 84);
  assert.equal(interception.game.timeoutsAway, 1);
  assert.equal(interception.game.timeoutsHome, 0);
  assert.equal(interception.game.possession, 'away');
  assert.equal(points.at(-1)!.game.isLive, false);
  assert.deepEqual(points.at(-1)!.probabilities, { overtime: 0, finalTie: 0 });
  assert.ok(points.every(p => p.origin === 'reconstructed'));
  assert.equal(new Set(points.map(p => p.id)).size, points.length);
  // A changed eventual winner must not change earlier reconstructed probabilities.
  summary.header.competitions[0].competitors[0].score = '20';
  assert.deepEqual(reconstructSummary(summary).slice(0, -1).map(p => p.probabilities), points.slice(0, -1).map(p => p.probabilities));
});

test('history persists original values below alert thresholds and retries unacknowledged uploads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiewon-history-')); const path = join(dir, 'history.sqlite');
  let store = new Store(path, 'dry-run'); const now = Date.now();
  try {
    store.observe(base, { overtime: .05, finalTie: .003 }, now);
    store.observe(base, { overtime: .06, finalTie: .004 }, now); // same identity preserves original estimate
    store.close(); store = new Store(path, 'dry-run');
    assert.equal(store.pendingSnapshots()[0].probabilities.overtime, .05);
    const env = { BOT_HISTORY_URL: 'https://example.com/api/history/ingest', BOT_HISTORY_TOKEN: 'fake' };
    await assert.rejects(syncHistory(store, env, async () => new Response('{}', { status: 503 })));
    assert.equal(store.pendingSnapshots().length, 1);
    await syncHistory(store, env, async () => Response.json({ saved: 1 }));
    assert.equal(store.pendingSnapshots().length, 0);
    const bad = snapshot(base, { overtime: NaN, finalTie: .2 }, now);
    assert.equal(validSnapshot(bad), false);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('old SQLite ledger migrates without losing successful posts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiewon-migration-')); const path = join(dir, 'history.sqlite');
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE posts (key TEXT PRIMARY KEY, game_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, probability REAL NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL, tweet_id TEXT, error TEXT); INSERT INTO posts VALUES ('old', '401000009', 'forecast', 'test', 0.5, 1, 'sent', '123', NULL)");
  db.close();
  const store = new Store(path, 'live');
  try { assert.equal(store.gameHistory(base.id).lastTweetId, '123'); assert.equal(store.gameHistory(base.id).followed, true); }
  finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('X posts use the documented reply body for game threads', async () => {
  let body: unknown;
  const client = new XClient({ apiKey: 'fake', apiSecret: 'fake', accessToken: 'fake', accessSecret: 'fake' }, async (_url, init) => {
    body = JSON.parse(String(init?.body)); return Response.json({ data: { id: '124' } });
  });
  assert.equal(await client.post('Overtime!', '123'), '124');
  assert.deepEqual(body, { text: 'Overtime!', reply: { in_reply_to_tweet_id: '123' } });
});

test('D1 schema and shared SQL preserve final state against delayed live uploads', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(readFileSync(new URL('../../web/drizzle/0000_material_black_bird.sql', import.meta.url), 'utf8'));
    const upsert = db.prepare(UPSERT_GAME);
    const write = (g: BotGame, time: number) => upsert.run(g.id, time, JSON.stringify(g), .2, .01);
    const now = Date.now();
    write(base, now);
    write({ ...base, isLive: false, homeScore: 13 }, now); // same wallclock as final play
    write(base, now + 1000); // late live collector must not undo the confirmed final
    let state = JSON.parse(String(db.prepare('SELECT state FROM games').get()!.state));
    assert.equal(state.isLive, false); assert.equal(state.homeScore, 13);
    write({ ...base, isLive: false, homeScore: 16 }, now + 2000); // provider correction allowed
    state = JSON.parse(String(db.prepare('SELECT state FROM games').get()!.state));
    assert.equal(state.homeScore, 16);
    const one = snapshot({ ...base, isLive: false }, { overtime: 0, finalTie: 0 }, now);
    const two = snapshot({ ...base, isLive: false }, { overtime: 0, finalTie: 0 }, now + 300000);
    assert.equal(one.id, two.id); // final polling cannot stretch the chart for hours
  } finally { db.close(); }
});
