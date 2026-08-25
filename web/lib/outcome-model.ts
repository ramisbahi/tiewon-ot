import outcomeData from './outcome-model-data.json';
import { featuresForState, TRY_SUCCESS_RATE } from './model';
import type { GameState } from './types';

interface ExportedTree {
  childrenLeft: number[];
  childrenRight: number[];
  feature: number[];
  threshold: number[];
  value: number[];
}

interface ExportedOutcomeModel {
  version: string;
  baseScores: number[];
  learningRate: number;
  trees: ExportedTree[][];
  calibration: Array<{ x: number[]; y: number[] }>;
  trainingSummary: {
    games: number;
    snapshots: number;
    multiclass_log_loss: number;
    accuracy: number;
    tie_brier: number;
    tie_auc: number;
  };
}

export interface RegulationOutcomes {
  awayAhead: number;
  tied: number;
  homeAhead: number;
}

const model = outcomeData as ExportedOutcomeModel;

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

function evaluateTree(tree: ExportedTree, features: number[]) {
  let node = 0;
  while (tree.childrenLeft[node] !== -1) {
    node = features[tree.feature[node]] <= tree.threshold[node] ? tree.childrenLeft[node] : tree.childrenRight[node];
  }
  return tree.value[node];
}

function predictScrimmage(state: GameState): RegulationOutcomes {
  if (state.quarter > 4 || (state.quarter === 4 && state.clockSeconds <= 0)) {
    if (state.homeScore === state.awayScore) return { awayAhead: 0, tied: 1, homeAhead: 0 };
    return state.homeScore > state.awayScore
      ? { awayAhead: 0, tied: 0, homeAhead: 1 }
      : { awayAhead: 1, tied: 0, homeAhead: 0 };
  }
  const features = featuresForState(state);
  const scores = [...model.baseScores];
  for (const stage of model.trees) {
    for (let classIndex = 0; classIndex < stage.length; classIndex += 1) {
      scores[classIndex] += model.learningRate * evaluateTree(stage[classIndex], features);
    }
  }
  const max = Math.max(...scores);
  const exp = scores.map((value) => Math.exp(value - max));
  const total = exp.reduce((sum, value) => sum + value, 0);
  const calibrated = exp.map((value, index) => interpolate(value / total, model.calibration[index].x, model.calibration[index].y));
  const calibratedTotal = calibrated.reduce((sum, value) => sum + value, 0);
  let values = calibrated.map((value) => value / calibratedTotal);

  const secondsRemaining = Math.max(0, (4 - state.quarter) * 900 + state.clockSeconds);
  const margin = Math.abs(state.homeScore - state.awayScore);
  if (secondsRemaining <= 120 && (margin === 1 || margin === 2)) {
    const tieCap = 0.0005 + (secondsRemaining / 120) * 0.0045;
    if (values[1] > tieCap) {
      const nonTie = values[0] + values[2];
      values = [values[0] / nonTie * (1 - tieCap), tieCap, values[2] / nonTie * (1 - tieCap)];
    }
  }

  // With at most 15 seconds and the trailing team outside midfield, or with
  // the leader possessing, a lead flip must remain a Hail-Mary-scale tail.
  // This corrects rare-class calibration from overwhelming physical clock and
  // field constraints in sparse end-game states.
  if (secondsRemaining <= 15 && margin > 0) {
    const homeLeads = state.homeScore > state.awayScore;
    const trailingTeam = homeLeads ? 'away' : 'home';
    const lowLeverage = state.possession !== trailingTeam || state.yardlineOwn < 50;
    if (lowLeverage) {
      const flipCap = state.possession === trailingTeam ? 0.02 : 0.005;
      if (homeLeads) {
        values[0] = Math.min(values[0], flipCap);
        values[2] = 1 - values[0] - values[1];
      } else {
        values[2] = Math.min(values[2], flipCap);
        values[0] = 1 - values[1] - values[2];
      }
    }
  }
  return { awayAhead: values[0], tied: values[1], homeAhead: values[2] };
}

function resolvedTry(state: GameState, success: boolean): GameState {
  const points = success ? (state.tryType === 'kick' ? 1 : 2) : 0;
  return {
    ...state,
    awayScore: state.awayScore + (state.pendingTryTeam === 'away' ? points : 0),
    homeScore: state.homeScore + (state.pendingTryTeam === 'home' ? points : 0),
    possession: state.pendingTryTeam === 'home' ? 'away' : 'home',
    phase: 'scrimmage', down: 1, distance: 10, yardlineOwn: 25,
  };
}

export function predictRegulationOutcomes(state: GameState): RegulationOutcomes {
  if (state.phase !== 'pending_try') return predictScrimmage(state);
  const rate = TRY_SUCCESS_RATE[state.tryType];
  const success = predictScrimmage(resolvedTry(state, true));
  const failure = predictScrimmage(resolvedTry(state, false));
  return {
    awayAhead: rate * success.awayAhead + (1 - rate) * failure.awayAhead,
    tied: rate * success.tied + (1 - rate) * failure.tied,
    homeAhead: rate * success.homeAhead + (1 - rate) * failure.homeAhead,
  };
}

export const outcomeModelSummary = { version: model.version, ...model.trainingSummary };
