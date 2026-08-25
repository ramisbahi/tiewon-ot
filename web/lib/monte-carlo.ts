import simulationData from './simulation-data.json';
import type { GameState, Possession } from './types';

type DriveResult = 'Touchdown' | 'Field goal' | 'Safety' | 'Opp touchdown' | 'No score';

interface SimulationResult {
  estimate: number;
  awayAhead: number;
  homeAhead: number;
  awayWin: number;
  homeWin: number;
  finalDraw: number;
  lower: number;
  upper: number;
  ties: number;
  runs: number;
}

function hash(text: string) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function rng(seed: number) {
  let value = seed || 0x9e3779b9;
  return () => {
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    return (value >>> 0) / 4294967296;
  };
}

function other(side: Possession): Possession { return side === 'home' ? 'away' : 'home'; }

function remainingSeconds(state: GameState) {
  return Math.max(0, (4 - state.quarter) * 900 + state.clockSeconds);
}

function fieldBin(yardlineOwn: number) {
  const index = simulationData.fieldEdges.findIndex((edge, position) =>
    position < simulationData.fieldEdges.length - 1
      && yardlineOwn > edge && yardlineOwn <= simulationData.fieldEdges[position + 1]);
  return simulationData.fieldLabels[Math.max(0, index)] as keyof typeof simulationData.bins;
}

function chooseOutcome(yardlineOwn: number, down: number, random: () => number): DriveResult {
  const source = simulationData.bins[fieldBin(yardlineOwn)].outcomes;
  const weights: Record<DriveResult, number> = { ...source };
  if (down === 4) {
    weights['No score'] *= 1.34;
    weights.Touchdown *= 0.7;
  }
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  let cursor = random() * total;
  for (const result of ['Touchdown', 'Field goal', 'Safety', 'Opp touchdown', 'No score'] as DriveResult[]) {
    cursor -= weights[result];
    if (cursor <= 0) return result;
  }
  return 'No score';
}

function chooseDuration(yardlineOwn: number, result: DriveResult, random: () => number) {
  const values = simulationData.bins[fieldBin(yardlineOwn)].durations[result];
  return values[Math.min(values.length - 1, Math.floor(random() * values.length))];
}

function addPoints(scores: { home: number; away: number }, side: Possession, points: number) {
  scores[side] += points;
}

function conversionPoints(scores: { home: number; away: number }, offense: Possession, random: () => number) {
  const defense = other(offense);
  const deficitAfterTouchdown = scores[defense] - scores[offense];
  const tryType = deficitAfterTouchdown === 2 || deficitAfterTouchdown === 8 ? 'two_point' : 'kick';
  const success = random() < simulationData.tryRates[tryType];
  return success ? (tryType === 'kick' ? 1 : 2) : 0;
}

function overtimeOutcome(
  scores: { home: number; away: number },
  rules: GameState['overtimeRules'],
  random: () => number,
): 'home' | 'away' | 'tie' {
  let offense: Possession = random() < 0.5 ? 'home' : 'away';
  let seconds = rules === 'postseason' ? 900 : 600;
  const possessions = { home: 0, away: 0 };
  let suddenDeath = false;
  let periods = 0;

  while (periods < 6) {
    const result = chooseOutcome(25, 1, random);
    const duration = chooseDuration(25, result, random);
    if (duration > seconds) {
      if (rules !== 'postseason') return 'tie';
      seconds = 900;
      periods += 1;
      continue;
    }
    seconds -= duration;
    possessions[offense] += 1;
    const defense = other(offense);
    let scoringSide: Possession | null = null;
    let touchdown = false;
    if (result === 'Touchdown') {
      addPoints(scores, offense, 6);
      addPoints(scores, offense, conversionPoints(scores, offense, random));
      scoringSide = offense;
      touchdown = true;
    } else if (result === 'Field goal') {
      addPoints(scores, offense, 3);
      scoringSide = offense;
    } else if (result === 'Safety') {
      addPoints(scores, defense, 2);
      scoringSide = defense;
    } else if (result === 'Opp touchdown') {
      addPoints(scores, defense, 6);
      addPoints(scores, defense, conversionPoints(scores, defense, random));
      scoringSide = defense;
      touchdown = true;
    }

    // A defensive score ends overtime because the scoring team possessed the
    // turnover. Under legacy rules, an opening offensive touchdown also ends it.
    if (scoringSide === defense) return scoringSide;
    if (rules === 'legacy_regular' && possessions.home + possessions.away === 1 && touchdown) return offense;

    const bothPossessed = possessions.home > 0 && possessions.away > 0;
    if (bothPossessed && scores.home !== scores.away) return scores.home > scores.away ? 'home' : 'away';
    if (bothPossessed) suddenDeath = true;
    if (suddenDeath && scoringSide && scores.home !== scores.away) return scores.home > scores.away ? 'home' : 'away';
    offense = defense;
  }
  if (scores.home !== scores.away) return scores.home > scores.away ? 'home' : 'away';
  return rules === 'postseason' ? (random() < 0.5 ? 'home' : 'away') : 'tie';
}

function simulateOnce(state: GameState, run: number) {
  const random = rng(hash(`${state.id}|${state.awayScore}|${state.homeScore}|${state.quarter}|${state.clockSeconds}|${state.possession}|${state.phase}|${state.tryType}|${run}`));
  const scores = { home: state.homeScore, away: state.awayScore };
  let offense = state.possession;
  let seconds = remainingSeconds(state);
  let yardlineOwn = state.yardlineOwn;
  let down = state.down;
  let firstDrive = true;

  if (state.phase === 'pending_try') {
    const success = random() < simulationData.tryRates[state.tryType];
    if (success) addPoints(scores, state.pendingTryTeam, state.tryType === 'kick' ? 1 : 2);
    offense = other(state.pendingTryTeam);
    yardlineOwn = 25;
    down = 1;
  }

  while (seconds > 0) {
    const result = chooseOutcome(yardlineOwn, down, random);
    let duration = chooseDuration(yardlineOwn, result, random);
    const scoreDiff = scores[offense] - scores[other(offense)];
    if (firstDrive) {
      // The source distributions contain complete drives. A live/custom state is
      // usually partway through one, so approximate its remaining share from
      // field position and late-game tempo before sampling future full drives.
      const remainingShare = Math.max(0.18, Math.min(1, (100 - yardlineOwn) / 75));
      const urgency = seconds <= 180 && scoreDiff <= 0 ? 0.25 : 0.72;
      duration = Math.max(6, Math.round(duration * remainingShare * urgency));
    } else if (seconds <= 300 && scoreDiff <= 0) {
      duration = Math.max(10, Math.round(duration * 0.4));
    }
    if (duration > seconds) break;
    seconds -= duration;
    firstDrive = false;

    if (result === 'Touchdown') {
      addPoints(scores, offense, 6);
      addPoints(scores, offense, conversionPoints(scores, offense, random));
      offense = other(offense);
    } else if (result === 'Field goal') {
      addPoints(scores, offense, 3);
      offense = other(offense);
    } else if (result === 'Safety') {
      addPoints(scores, other(offense), 2);
      offense = other(offense);
    } else if (result === 'Opp touchdown') {
      const defense = other(offense);
      addPoints(scores, defense, 6);
      addPoints(scores, defense, conversionPoints(scores, defense, random));
    } else {
      offense = other(offense);
    }
    yardlineOwn = 25;
    down = 1;
  }
  const regulation = scores.home === scores.away ? 'tie' : scores.home > scores.away ? 'home' : 'away';
  const final = regulation === 'tie' ? overtimeOutcome(scores, state.overtimeRules, random) : regulation;
  return { regulation, final };
}

function summarize(
  ties: number, homeAhead: number, awayAhead: number,
  homeWins: number, awayWins: number, finalDraws: number, runs: number,
): SimulationResult {
  const estimate = ties / runs;
  const z = 1.96;
  const denominator = 1 + z * z / runs;
  const center = (estimate + z * z / (2 * runs)) / denominator;
  const margin = z * Math.sqrt((estimate * (1 - estimate) + z * z / (4 * runs)) / runs) / denominator;
  return {
    estimate,
    homeAhead: homeAhead / runs,
    awayAhead: awayAhead / runs,
    homeWin: homeWins / runs,
    awayWin: awayWins / runs,
    finalDraw: finalDraws / runs,
    lower: Math.max(0, center - margin), upper: Math.min(1, center + margin), ties, runs,
  };
}

export function simulateTieProbability(state: GameState, runs = 10_000) {
  let ties = 0;
  let homeAhead = 0;
  let awayAhead = 0;
  let homeWins = 0;
  let awayWins = 0;
  let finalDraws = 0;
  for (let run = 0; run < runs; run += 1) {
    const outcome = simulateOnce(state, run);
    ties += outcome.regulation === 'tie' ? 1 : 0;
    homeAhead += outcome.regulation === 'home' ? 1 : 0;
    awayAhead += outcome.regulation === 'away' ? 1 : 0;
    homeWins += outcome.final === 'home' ? 1 : 0;
    awayWins += outcome.final === 'away' ? 1 : 0;
    finalDraws += outcome.final === 'tie' ? 1 : 0;
  }
  return summarize(ties, homeAhead, awayAhead, homeWins, awayWins, finalDraws, runs);
}

export async function simulateTieProbabilityAsync(
  state: GameState,
  runs = 10_000,
  onProgress?: (progress: number) => void,
  isCancelled?: () => boolean,
) {
  let ties = 0;
  let homeAhead = 0;
  let awayAhead = 0;
  let homeWins = 0;
  let awayWins = 0;
  let finalDraws = 0;
  const chunkSize = 500;
  for (let start = 0; start < runs; start += chunkSize) {
    if (isCancelled?.()) return null;
    const end = Math.min(runs, start + chunkSize);
    for (let run = start; run < end; run += 1) {
      const outcome = simulateOnce(state, run);
      ties += outcome.regulation === 'tie' ? 1 : 0;
      homeAhead += outcome.regulation === 'home' ? 1 : 0;
      awayAhead += outcome.regulation === 'away' ? 1 : 0;
      homeWins += outcome.final === 'home' ? 1 : 0;
      awayWins += outcome.final === 'away' ? 1 : 0;
      finalDraws += outcome.final === 'tie' ? 1 : 0;
    }
    onProgress?.(end / runs);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return summarize(ties, homeAhead, awayAhead, homeWins, awayWins, finalDraws, runs);
}

export const simulationSummary = {
  version: simulationData.version,
  games: simulationData.games,
  drives: simulationData.drives,
};

export type { SimulationResult };
