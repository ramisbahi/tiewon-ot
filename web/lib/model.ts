import modelData from './model-data.json';
import type { GameState } from './types';

interface ExportedTree {
  childrenLeft: number[];
  childrenRight: number[];
  feature: number[];
  threshold: number[];
  value: number[];
}

interface ExportedModel {
  version: string;
  featureNames: string[];
  baseScore: number;
  learningRate: number;
  trees: ExportedTree[];
  calibration: { x: number[]; y: number[] };
  conditionalFinalTieRate: number;
  trainingSummary: {
    games: number;
    overtimeGames: number;
    snapshots: number;
    oofBrier: number;
    legacyBrier: number;
  };
}

const model = modelData as ExportedModel;

function clamp(value: number, low: number, high: number) {
  return Math.min(high, Math.max(low, value));
}

function interpolate(value: number, x: number[], y: number[]) {
  if (value <= x[0]) return y[0];
  if (value >= x[x.length - 1]) return y[y.length - 1];
  let low = 0;
  let high = x.length - 1;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (x[middle] <= value) low = middle;
    else high = middle;
  }
  const span = x[high] - x[low];
  if (span <= 0) return y[low];
  const weight = (value - x[low]) / span;
  return y[low] + weight * (y[high] - y[low]);
}

function featuresForState(state: GameState) {
  const secondsRemaining = clamp((4 - state.quarter) * 900 + state.clockSeconds, 0, 3600);
  const homeDiff = state.homeScore - state.awayScore;
  const scoreDiffOffense = clamp(state.possession === 'home' ? homeDiff : -homeDiff, -28, 28);
  const absoluteScoreDiff = Math.abs(scoreDiffOffense);
  const yardsToGoal = clamp(100 - state.yardlineOwn, 1, 99);
  const offenseTimeouts = state.possession === 'home' ? state.timeoutsHome : state.timeoutsAway;
  const defenseTimeouts = state.possession === 'home' ? state.timeoutsAway : state.timeoutsHome;
  const values: Record<string, number> = {
    seconds_remaining: secondsRemaining,
    time_fraction: secondsRemaining / 3600,
    fourth_quarter: state.quarter === 4 ? 1 : 0,
    final_two_minutes: secondsRemaining <= 120 ? 1 : 0,
    score_diff_offense: scoreDiffOffense,
    absolute_score_diff: absoluteScoreDiff,
    is_tied: scoreDiffOffense === 0 ? 1 : 0,
    one_score_game: absoluteScoreDiff <= 8 ? 1 : 0,
    offense_trails: scoreDiffOffense < 0 ? 1 : 0,
    field_goal_ties: scoreDiffOffense === -3 ? 1 : 0,
    touchdown_can_tie: [-8, -7, -6].includes(scoreDiffOffense) ? 1 : 0,
    down: clamp(state.down || 1, 1, 4),
    yards_to_go: clamp(state.distance || 10, 1, 30),
    yards_to_goal: yardsToGoal,
    in_field_goal_range: yardsToGoal <= 40 ? 1 : 0,
    offense_timeouts: clamp(offenseTimeouts, 0, 3),
    defense_timeouts: clamp(defenseTimeouts, 0, 3),
    home_possession: state.possession === 'home' ? 1 : 0,
    time_score_pressure: absoluteScoreDiff / Math.sqrt(secondsRemaining + 30),
  };
  return model.featureNames.map((name) => values[name] ?? 0);
}

function evaluateTree(tree: ExportedTree, features: number[]) {
  let node = 0;
  while (tree.childrenLeft[node] !== -1) {
    node = features[tree.feature[node]] <= tree.threshold[node]
      ? tree.childrenLeft[node]
      : tree.childrenRight[node];
  }
  return tree.value[node];
}

export function predictRegulationTie(state: GameState) {
  if (state.quarter > 4) return 1;
  if (state.quarter === 4 && state.clockSeconds <= 0) {
    return state.homeScore === state.awayScore ? 1 : 0;
  }
  const features = featuresForState(state);
  let raw = model.baseScore;
  for (const tree of model.trees) raw += model.learningRate * evaluateTree(tree, features);
  const uncalibrated = 1 / (1 + Math.exp(-raw));
  return clamp(interpolate(uncalibrated, model.calibration.x, model.calibration.y), 0.0005, 0.995);
}

export function forecast(state: GameState) {
  const regulationTie = predictRegulationTie(state);
  const finalDraw = state.seasonType === 'postseason'
    ? 0
    : regulationTie * model.conditionalFinalTieRate;
  return { regulationTie, finalDraw };
}

export const modelSummary = {
  version: model.version,
  ...model.trainingSummary,
  conditionalFinalTieRate: model.conditionalFinalTieRate,
};
