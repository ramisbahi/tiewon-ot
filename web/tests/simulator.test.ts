import assert from 'node:assert/strict';
import test from 'node:test';
import { simulateTieProbability } from '../lib/monte-carlo';
import { simulateNextPlay } from '../lib/simulator';
import type { GameState } from '../lib/types';

function state(overrides: Partial<GameState> = {}): GameState {
  return {
    id: 'custom-test', awayTeam: 'BUF', homeTeam: 'KC', awayScore: 20, homeScore: 27,
    quarter: 4, clockSeconds: 78, clockLabel: '1:18', possession: 'away',
    phase: 'scrimmage', tryType: 'kick', pendingTryTeam: 'away', down: 1,
    overtimeRules: 'current_regular',
    distance: 10, yardlineOwn: 31, timeoutsHome: 2, timeoutsAway: 2,
    status: 'TEST', detail: 'Test', isLive: false, seasonType: 'regular', source: 'demo',
    ...overrides,
  };
}

test('scenario playback advances the state it receives instead of preset one', () => {
  const input = state({ id: 'down-three', awayTeam: 'NYJ', homeTeam: 'MIA', awayScore: 17, homeScore: 20 });
  const result = simulateNextPlay(input, 1);
  assert.equal(result.state.id, 'down-three');
  assert.equal(result.state.awayTeam, 'NYJ');
  assert.equal(result.state.homeTeam, 'MIA');
  assert.notEqual(result.state.awayTeam, 'MIN');
});

test('different custom scenarios do not collapse to the same first scenario', () => {
  const first = simulateNextPlay(state({ id: 'one', awayTeam: 'A1', homeTeam: 'H1' }), 1).state;
  const second = simulateNextPlay(state({ id: 'two', awayTeam: 'A2', homeTeam: 'H2', clockSeconds: 42 }), 1).state;
  assert.equal(first.id, 'one');
  assert.equal(second.id, 'two');
  assert.equal(second.awayTeam, 'A2');
});

test('pending tries resolve before returning to scrimmage', () => {
  const input = state({ phase: 'pending_try', pendingTryTeam: 'away', possession: 'away', awayScore: 26, homeScore: 27 });
  const result = simulateNextPlay(input, 2);
  assert.equal(result.state.phase, 'scrimmage');
  assert.equal(result.state.possession, 'home');
  assert.ok(result.state.awayScore === 26 || result.state.awayScore === 27);
});

test('Monte Carlo is deterministic and respects a pending kick at 0:00', () => {
  const input = state({
    awayScore: 26, homeScore: 27, clockSeconds: 0, phase: 'pending_try',
    pendingTryTeam: 'away', possession: 'away', tryType: 'kick',
  });
  const first = simulateTieProbability(input, 4_000);
  const second = simulateTieProbability(input, 4_000);
  assert.deepEqual(first, second);
  assert.ok(first.estimate > 0.92 && first.estimate < 0.97);
  assert.ok(Math.abs(first.awayAhead + first.estimate + first.homeAhead - 1) < 1e-12);
  assert.ok(Math.abs(first.awayWin + first.finalDraw + first.homeWin - 1) < 1e-12);
});

test('Monte Carlo late one-point margin sanity check stays near zero', () => {
  const result = simulateTieProbability(state({ homeScore: 21, awayScore: 20, clockSeconds: 10 }), 4_000);
  assert.ok(result.estimate <= 0.01, `expected <=1%, got ${result.estimate}`);
});

test('postseason overtime cannot produce a final draw', () => {
  const result = simulateTieProbability(state({ awayScore: 24, homeScore: 24, clockSeconds: 0, overtimeRules: 'postseason', seasonType: 'postseason' }), 4_000);
  assert.equal(result.estimate, 1);
  assert.equal(result.finalDraw, 0);
});
