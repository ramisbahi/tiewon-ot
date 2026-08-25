import assert from 'node:assert/strict';
import test from 'node:test';
import { predictRegulationTie, TRY_SUCCESS_RATE } from '../lib/model';
import { predictRegulationOutcomes } from '../lib/outcome-model';
import type { GameState } from '../lib/types';

function state(overrides: Partial<GameState> = {}): GameState {
  return {
    id: 'test', awayTeam: 'AWY', homeTeam: 'HME', awayScore: 24, homeScore: 24,
    quarter: 4, clockSeconds: 60, clockLabel: '1:00', possession: 'away',
    phase: 'scrimmage', tryType: 'kick', pendingTryTeam: 'away', down: 1,
    overtimeRules: 'current_regular',
    distance: 10, yardlineOwn: 25, timeoutsHome: 2, timeoutsAway: 2,
    status: 'TEST', detail: 'Test', isLive: false, seasonType: 'regular', source: 'demo',
    ...overrides,
  };
}

test('the historical forecast is deterministic', () => {
  const input = state();
  assert.equal(predictRegulationTie(input), predictRegulationTie(input));
});

test('regulation end is exactly tied or not tied', () => {
  assert.equal(predictRegulationTie(state({ clockSeconds: 0 })), 1);
  assert.equal(predictRegulationTie(state({ clockSeconds: 0, homeScore: 25 })), 0);
});

test('ordinary one-point margins are near zero late, regardless of possession', () => {
  for (const possession of ['home', 'away'] as const) {
    const estimate = predictRegulationTie(state({ homeScore: 25, clockSeconds: 10, possession }));
    assert.ok(estimate <= 0.001, `expected <=0.1%, got ${estimate}`);
  }
});

test('a pending extra point is resolved before regulation ends', () => {
  const estimate = predictRegulationTie(state({
    awayScore: 24, homeScore: 25, clockSeconds: 0, phase: 'pending_try',
    pendingTryTeam: 'away', possession: 'away', tryType: 'kick',
  }));
  assert.ok(Math.abs(estimate - TRY_SUCCESS_RATE.kick) < 1e-10);
});

test('a pending two-point try uses its distinct conversion rate', () => {
  const estimate = predictRegulationTie(state({
    awayScore: 23, homeScore: 25, clockSeconds: 0, phase: 'pending_try',
    pendingTryTeam: 'away', possession: 'away', tryType: 'two_point',
  }));
  assert.ok(Math.abs(estimate - TRY_SUCCESS_RATE.two_point) < 1e-10);
});

test('three-way historical outcomes are normalized', () => {
  const outcome = predictRegulationOutcomes(state());
  assert.ok(Math.abs(outcome.awayAhead + outcome.tied + outcome.homeAhead - 1) < 1e-10);
});

test('three-way model respects a late leader with the opponent outside midfield', () => {
  const outcome = predictRegulationOutcomes(state({ homeScore: 25, awayScore: 24, clockSeconds: 10, possession: 'away', yardlineOwn: 25 }));
  assert.ok(outcome.homeAhead >= 0.97, `expected home to remain ahead, got ${outcome.homeAhead}`);
  assert.ok(outcome.awayAhead <= 0.02);
});

test('three-way model also resolves a pending extra point', () => {
  const outcome = predictRegulationOutcomes(state({
    awayScore: 24, homeScore: 25, clockSeconds: 0, phase: 'pending_try', pendingTryTeam: 'away',
  }));
  assert.ok(Math.abs(outcome.tied - TRY_SUCCESS_RATE.kick) < 1e-10);
  assert.ok(Math.abs(outcome.homeAhead - (1 - TRY_SUCCESS_RATE.kick)) < 1e-10);
});
