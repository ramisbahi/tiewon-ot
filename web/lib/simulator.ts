import { TRY_SUCCESS_RATE } from './model';
import type { GameState, Possession } from './types';

export interface SimulatedPlay {
  state: GameState;
  event: string;
}

function hash(text: string) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function randomFor(state: GameState, step: number, salt: string) {
  const key = [state.id, state.awayScore, state.homeScore, state.quarter, state.clockSeconds,
    state.possession, state.down, state.distance, state.yardlineOwn, step, salt].join('|');
  let value = hash(key);
  value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
  return (value >>> 0) / 4294967296;
}

function clockLabel(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function other(side: Possession): Possession { return side === 'home' ? 'away' : 'home'; }

function addPoints(state: GameState, side: Possession, points: number) {
  return {
    homeScore: state.homeScore + (side === 'home' ? points : 0),
    awayScore: state.awayScore + (side === 'away' ? points : 0),
  };
}

function advanceClock(state: GameState, elapsed: number) {
  if (elapsed < state.clockSeconds) {
    const clockSeconds = state.clockSeconds - elapsed;
    return { quarter: state.quarter, clockSeconds, clockLabel: clockLabel(clockSeconds) };
  }
  if (state.quarter >= 4) return { quarter: 4, clockSeconds: 0, clockLabel: '0:00' };
  return { quarter: state.quarter + 1, clockSeconds: 900, clockLabel: '15:00' };
}

export function simulateNextPlay(state: GameState, step = 1): SimulatedPlay {
  if (state.phase === 'pending_try') {
    const success = randomFor(state, step, 'try') < TRY_SUCCESS_RATE[state.tryType];
    const points = success ? (state.tryType === 'kick' ? 1 : 2) : 0;
    const nextPossession = other(state.pendingTryTeam);
    const scores = addPoints(state, state.pendingTryTeam, points);
    return {
      state: {
        ...state, ...scores, possession: nextPossession, phase: 'scrimmage', down: 1,
        distance: 10, yardlineOwn: 25, detail: 'Scenario playback',
      },
      event: success
        ? `${state.tryType === 'kick' ? 'Extra point' : 'Two-point try'} is good`
        : `${state.tryType === 'kick' ? 'Extra point' : 'Two-point try'} fails`,
    };
  }

  if (state.quarter >= 4 && state.clockSeconds <= 0) {
    return { state, event: 'Regulation has ended' };
  }

  const outcome = randomFor(state, step, 'outcome');
  const elapsed = Math.min(state.clockSeconds || 1, 7 + Math.floor(randomFor(state, step, 'clock') * 27));
  const clock = advanceClock(state, elapsed);
  const offense = state.possession;
  const defense = other(offense);

  const touchdownChance = state.yardlineOwn >= 80 ? 0.17 : state.yardlineOwn >= 60 ? 0.055 : 0.018;
  if (outcome < touchdownChance) {
    const scores = addPoints(state, offense, 6);
    return {
      state: {
        ...state, ...scores, ...clock, phase: 'pending_try', pendingTryTeam: offense,
        tryType: 'kick', down: 1, distance: 2, yardlineOwn: 98,
      },
      event: `${offense === 'home' ? state.homeTeam : state.awayTeam} touchdown — conversion pending`,
    };
  }

  const fieldGoalDistance = 117 - state.yardlineOwn;
  const attemptFieldGoal = state.down === 4 && fieldGoalDistance <= 60;
  if (attemptFieldGoal) {
    const makeRate = Math.max(0.43, Math.min(0.97, 1.09 - fieldGoalDistance * 0.009));
    const made = randomFor(state, step, 'field-goal') < makeRate;
    const scores = addPoints(state, offense, made ? 3 : 0);
    return {
      state: {
        ...state, ...scores, ...clock, possession: defense, down: 1, distance: 10,
        yardlineOwn: made ? 25 : Math.max(1, 100 - state.yardlineOwn),
      },
      event: `${fieldGoalDistance}-yard field goal ${made ? 'is good' : 'misses'}`,
    };
  }

  if (outcome > 0.965) {
    return {
      state: {
        ...state, ...clock, possession: defense, down: 1, distance: 10,
        yardlineOwn: Math.max(1, 100 - state.yardlineOwn),
      },
      event: 'Turnover — possession changes',
    };
  }

  const gain = Math.max(-7, Math.round((randomFor(state, step, 'yards') - 0.32) * 16));
  const newYardline = Math.max(1, Math.min(99, state.yardlineOwn + gain));
  if (gain >= state.distance) {
    return {
      state: { ...state, ...clock, yardlineOwn: newYardline, down: 1, distance: Math.min(10, 100 - newYardline) },
      event: `${gain >= 0 ? `${gain}-yard gain` : `Loss of ${Math.abs(gain)}`} — first down`,
    };
  }

  if (state.down >= 4) {
    return {
      state: {
        ...state, ...clock, possession: defense, down: 1, distance: 10,
        yardlineOwn: Math.max(1, 100 - newYardline),
      },
      event: `${gain >= 0 ? `${gain}-yard gain` : `Loss of ${Math.abs(gain)}`} — turnover on downs`,
    };
  }

  return {
    state: {
      ...state, ...clock, yardlineOwn: newYardline, down: state.down + 1,
      distance: Math.min(30, Math.max(1, state.distance - gain)),
    },
    event: gain >= 0 ? `${gain}-yard gain` : `Loss of ${Math.abs(gain)}`,
  };
}
