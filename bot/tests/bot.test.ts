import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorization, credentials, XClient, XError } from '../x-client';
import { readConfig } from '../config';
import { botGames, fetchGames } from '../feed';
import { nextPost } from '../policy';
import { Store } from '../store';
import { CONNECTION_TEST, publishGames, publishPost } from '../engine';
import type { BotGame as GameState } from '../types';
import { EMPTY_HISTORY } from '../types';

const now = Date.now();
const config = readConfig({});
function game(overrides: Partial<GameState> = {}): GameState {
  return {
    id: '401000001', awayTeam: 'DET', homeTeam: 'GB', awayScore: 24, homeScore: 24,
    quarter: 4, clockSeconds: 30, clockLabel: '0:30', possession: 'away',
    phase: 'scrimmage', tryType: 'kick', pendingTryTeam: 'away', down: 1,
    overtimeRules: 'current_regular', distance: 10, yardlineOwn: 25,
    timeoutsHome: 2, timeoutsAway: 2, status: 'STATUS_IN_PROGRESS', detail: 'Live',
    isLive: true, seasonType: 'regular', source: 'live', fieldStateReliable: true, ...overrides,
  };
}
function event() {
  return {
    id: '401000001', date: new Date(now - 3 * 3600_000).toISOString(), season: { slug: 'regular-season', year: 2026 },
    competitions: [{
      status: { period: 4, clock: 30, displayClock: '0:30', type: { state: 'in', name: 'STATUS_IN_PROGRESS', completed: false } },
      competitors: [
        { id: '8', homeAway: 'away', score: '24', team: { abbreviation: 'DET' } },
        { id: '9', homeAway: 'home', score: '24', team: { abbreviation: 'GB' } },
      ],
      situation: { possession: '8', down: 1, distance: 10, possessionText: 'DET 25', homeTimeouts: 2, awayTimeouts: 2, lastPlay: { text: 'Incomplete pass' } },
    }],
  };
}
const noop = () => {};

test('connection test labels its content, never posts in dry-run, and suppresses repeated live sends', async () => {
  let calls = 0;
  const post = async () => { calls++; return '12345'; };
  const preview = new Store(':memory:', 'dry-run');
  const live = new Store(':memory:', 'live');
  try {
    assert.equal(await publishPost(CONNECTION_TEST, preview, config, post, now, noop), true);
    assert.equal(calls, 0);
    assert.equal(await publishPost(CONNECTION_TEST, live, { ...config, live: true }, post, now, noop), true);
    assert.equal(await publishPost(CONNECTION_TEST, live, { ...config, live: true }, post, now + 600_000, noop), false);
    assert.equal(calls, 1);
    assert.match(CONNECTION_TEST.text, /test post, not a live game prediction/);
  } finally { preview.close(); live.close(); }
});

test('OAuth signing matches the published OAuth 1.0 photos example', () => {
  const header = authorization('GET', 'http://photos.example.net/photos?file=vacation.jpg&size=original', {
    apiKey: 'dpf43f3p2l4k3l03', apiSecret: 'kd94hf93k423kf44', accessToken: 'nnch734d00sl2jdk', accessSecret: 'pfkkdhi9sl3r4s00',
  }, 'kllo9940pd9333jh', '1191242096');
  assert.ok(header.includes('oauth_signature="tR3%2BTy81lMeYAr%2FFid0kMTYa%2FWM%3D"'));
});

test('defaults are dry-run and live credentials require all four components', () => {
  assert.equal(config.live, false);
  assert.throws(() => readConfig({ BOT_LIVE: 'yes' }), /true or false/);
  assert.throws(() => credentials({ X_ACCESS_TOKEN: 'fake', X_ACCESS_TOKEN_SECRET: 'fake' }), /X_API_KEY, X_API_SECRET/);
});

test('feed accepts complete states and rejects stale, incomplete, preseason, suspended, and pending-try states', () => {
  assert.equal(botGames({ events: [event()] }, now).length, 1);
  const changes = [
    (e: ReturnType<typeof event>) => { e.date = new Date(now - 86400_000).toISOString(); },
    (e: ReturnType<typeof event>) => { e.season.slug = 'pre-season'; },
    (e: ReturnType<typeof event>) => { e.competitions[0].situation.possession = 'unknown'; },
    (e: ReturnType<typeof event>) => { e.competitions[0].situation.homeTimeouts = NaN; },
    (e: ReturnType<typeof event>) => { e.competitions[0].situation.down = 0; },
    (e: ReturnType<typeof event>) => { e.competitions[0].situation.possessionText = ''; },
    (e: ReturnType<typeof event>) => { e.competitions[0].situation.lastPlay.text = 'Touchdown'; },
    (e: ReturnType<typeof event>) => { e.competitions[0].status.type.name = 'STATUS_SUSPENDED'; },
    (e: ReturnType<typeof event>) => { e.competitions[0].status.clock = 0; },
  ];
  for (const change of changes) {
    const e = event(); change(e);
    assert.ok(!botGames({ events: [e] }, now)[0]?.fieldStateReliable);
  }
  assert.throws(() => botGames({ error: 'outage' }), /events missing/);
});

test('feed includes confirmed overtime and finals even without scrimmage details', () => {
  const ot = event(); ot.competitions[0].status.period = 5; ot.competitions[0].situation.down = 0;
  assert.equal(botGames({ events: [ot] }, now)[0].quarter, 5);
  const final = event();
  final.competitions[0].status.type = { state: 'post', name: 'STATUS_FINAL', completed: true };
  final.competitions[0].status.clock = 0;
  assert.equal(botGames({ events: [final] }, now)[0].isLive, false);
});

test('ESPN cache staleness is rejected and date range spans UTC midnight', async () => {
  let requested = '';
  await assert.rejects(fetchGames(now, (async (url) => {
    requested = String(url);
    return new Response(JSON.stringify({ events: [] }), { headers: { age: '500' } });
  }) as typeof fetch), /stale/);
  assert.match(requested, /dates=\d{8}-\d{8}/);
});

test('policy keeps predictions out of early/demo/incomplete states and closes followed games', () => {
  assert.ok(nextPost(game(), EMPTY_HISTORY, 0.65));
  for (const overrides of [{ source: 'demo' }, { quarter: 3 }, { clockSeconds: 0 }, { phase: 'pending_try' }, { fieldStateReliable: false }] as Partial<GameState>[]) {
    assert.equal(nextPost(game(overrides), EMPTY_HISTORY, 0.65), null);
  }
  const history = { ...EMPTY_HISTORY, followed: true, q4Milestone: .75 };
  assert.equal(nextPost(game(), history, .70), null);
  assert.ok(nextPost(game({ quarter: 5 }), history, null));
  assert.equal(nextPost(game({ isLive: false, homeScore: 27 }), EMPTY_HISTORY, 0), null);
  assert.ok(nextPost(game({ isLive: false, homeScore: 27 }), history, 0));
});

test('generated forecasts and outcomes fit X ASCII text limits', () => {
  for (const g of [game(), game({ quarter: 5 }), game({ isLive: false, homeScore: 27 })]) {
    const p = nextPost(g, { ...EMPTY_HISTORY, followed: true }, .95)!;
    assert.ok(p.text.length <= 280);
    assert.match(p.text, /^[\x20-\x7e\n]+$/);
  }
});

test('dry-run never calls X and duplicate alerts remain suppressed across restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiewon-test-'));
  const path = join(dir, 'state.sqlite');
  let calls = 0;
  const post = async () => { calls++; return '123'; };
  let store = new Store(path, 'dry-run');
  try {
    assert.equal(await publishGames([game({ quarter: 5 })], store, config, post, now, noop), 1);
    store.close(); store = new Store(path, 'dry-run');
    assert.equal(await publishGames([game({ quarter: 5 })], store, config, post, now + 600_000, noop), 0);
    assert.equal(calls, 0);
    assert.throws(() => new Store(path, 'live'), /mode mismatch/);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('atomic claim prevents competing workers from sending while delivery is in flight', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiewon-race-'));
  const path = join(dir, 'state.sqlite');
  const a = new Store(path, 'live'); const b = new Store(path, 'live');
  try {
    const p = nextPost(game(), EMPTY_HISTORY, .65)!;
    assert.equal(a.claim(p, config, now), true);
    assert.equal(b.claim(p, config, now), false);
    const other = nextPost(game({ id: '401000002' }), EMPTY_HISTORY, .65)!;
    assert.equal(b.claim(other, config, now), false);
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true }); }
});

test('ambiguous delivery halts posting and is not retried after restart', async () => {
  const store = new Store(':memory:', 'live');
  const live = { ...config, live: true };
  let calls = 0;
  const post = async () => { calls++; throw new Error('timeout'); };
  try {
    await assert.rejects(publishGames([game()], store, live, post, now, noop), /Delivery uncertain/);
    assert.equal(await publishGames([game()], store, live, post, now + 600_000, noop), 0);
    assert.equal(calls, 1);
    const key = String(store.history()[0].key);
    store.resolve(key, '12345');
    assert.equal(store.blocked(now), false);
    assert.equal(store.history()[0].status, 'sent');
  } finally { store.close(); }
});

test('rate limits persist cooldown and permit a fresh retry after reset', async () => {
  const store = new Store(':memory:', 'live'); const live = { ...config, live: true };
  try {
    await publishGames([game()], store, live, async () => { throw new XError(429, now + 1800_000); }, now, noop);
    assert.equal(store.blocked(now + 1000), true);
    assert.equal(store.history()[0].status, 'rejected');
    assert.equal(await publishGames([game()], store, live, async () => '123', now + 1801_000, noop), 1);
  } finally { store.close(); }
});

test('daily budget blocks additional games and resets at the next UTC day', async () => {
  const store = new Store(':memory:', 'dry-run'); const limited = { ...config, maxForecastsPerDay: 1 };
  try {
    const games = [game(), game({ id: '401000002' })];
    assert.equal(await publishGames(games, store, limited, async () => 'unused', now, noop), 1);
    assert.equal(await publishGames(games, store, limited, async () => 'unused', now + 86400_000, noop), 1);
  } finally { store.close(); }
});

test('account mismatch and API errors do not expose credentials or response text', async () => {
  const keys = { apiKey: 'fake-api', apiSecret: 'fake-secret', accessToken: 'fake-token', accessSecret: 'fake-access-secret' };
  const mismatch = new XClient(keys, (async () => new Response(JSON.stringify({ data: { username: 'wrong_account' } }))) as typeof fetch);
  await assert.rejects(mismatch.verifyAccount('NFL_TieWon'), /do not belong/);
  const rejected = new XClient(keys, (async () => new Response('fake-secret', { status: 403 })) as typeof fetch);
  await assert.rejects(rejected.post('Test'), (error: Error) => error.message === 'X API returned HTTP 403');
});
