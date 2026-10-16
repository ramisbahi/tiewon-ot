import data from './simulation-data.json';
import calibration from './ot-calibration.json';
import type { Possession } from './types';
import type { BotGame, OvertimeContext } from './live-types';

export const OT_MODEL_VERSION = `${data.version}-live-ot-v5-${calibration.version}`;
export const FIRST_DRIVE_BRANCHES = calibration.firstDrive;
type Branch = keyof typeof FIRST_DRIVE_BRANCHES;
const branches = Object.keys(FIRST_DRIVE_BRANCHES) as Branch[];
const branchTotal = branches.reduce((n, b) => n + FIRST_DRIVE_BRANCHES[b].probability, 0);
export const FRESH_OT_TIE_RATE = branches.reduce((n, b) => n + FIRST_DRIVE_BRANCHES[b].probability * FIRST_DRIVE_BRANCHES[b].tieGivenOutcome, 0) / branchTotal;
export function sampleFreshOvertimeTie(random: () => number): boolean {
  let cursor = random() * branchTotal;
  for (const branch of branches) {
    cursor -= FIRST_DRIVE_BRANCHES[branch].probability;
    if (cursor <= 0) return random() < FIRST_DRIVE_BRANCHES[branch].tieGivenOutcome;
  }
  return random() < FIRST_DRIVE_BRANCHES.noScore.tieGivenOutcome;
}
// User-specified strategy assumption, not a measured historical attempt rate.
export const OT_RESPONSE_TWO_POINT_RATE = 0.90;
type Outcome = 'Touchdown' | 'Field goal' | 'Safety' | 'Opp touchdown' | 'No score';
const other = (team: Possession): Possession => team === 'home' ? 'away' : 'home';
function randomFor(seed: string) {
  let value = 2166136261;
  for (const char of seed) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return () => { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; return (value >>> 0) / 4294967296; };
}
export interface OTFrame {
  scores: Record<Possession, number>;
  completed: Record<Possession, number>;
  offense: Possession;
}

// Separate deterministic rules from the empirical model so decisive plays can be tested directly.
export function resolveOvertimeDrive(frame: OTFrame, result: Outcome, rules: BotGame['overtimeRules'], random: () => number): boolean {
  const offense = frame.offense;
  const defense = other(offense);
  const total = frame.completed.home + frame.completed.away;
  const suddenDeath = total > 0 && frame.scores.home === frame.scores.away;
  if (result === 'Safety' || result === 'Opp touchdown') {
    frame.scores[defense] += result === 'Safety' ? 2 : 6;
    return true;
  }
  if (result === 'Touchdown') {
    frame.scores[offense] += 6;
    if (suddenDeath || rules === 'legacy_regular' && total === 0 || frame.completed[defense] > 0 && frame.scores[offense] > frame.scores[defense]) return true;
    const deficit = frame.scores[defense] - frame.scores[offense];
    // A 6–8 point opening-possession lead means the opponent scored a TD.
    // After the response TD, independently draw the decision and conversion.
    const respondingToTD = total === 1 && frame.completed[defense] === 1
      && frame.completed[offense] === 0 && deficit >= 0 && deficit <= 2;
    const two = respondingToTD ? random() < OT_RESPONSE_TWO_POINT_RATE : deficit === 2 || deficit === 8;
    if (random() < data.tryRates[two ? 'two_point' : 'kick']) frame.scores[offense] += two ? 2 : 1;
  } else if (result === 'Field goal') {
    frame.scores[offense] += 3;
    if (suddenDeath) return true;
  }
  frame.completed[offense]++;
  if (frame.completed.home > 0 && frame.completed.away > 0 && frame.scores.home !== frame.scores.away) return true;
  frame.offense = defense;
  return false;
}

function drawOnce(game: BotGame, context: OvertimeContext, random: () => number) {
  let branch = observedFirstDrive(game);
  const frame: OTFrame = { scores: { home: game.homeScore, away: game.awayScore }, completed: { ...context.completed }, offense: game.possession };
  let seconds = game.clockSeconds;
  let own = game.yardlineOwn;
  let first = true;
  while (seconds > 0) {
    const index = Math.max(0, data.fieldEdges.findIndex((edge, i) => i < data.fieldEdges.length - 1 && own > edge && own <= data.fieldEdges[i + 1]));
    const bin = data.bins[data.fieldLabels[index] as keyof typeof data.bins];
    const weights = { ...bin.outcomes };
    if (first && game.down === 4) { weights['No score'] *= 1.34; weights.Touchdown *= 0.7; }
    let cursor = random() * Object.values(weights).reduce((a, b) => a + b, 0);
    let result: Outcome = 'No score';
    for (const [key, weight] of Object.entries(weights)) { cursor -= weight; if (cursor <= 0) { result = key as Outcome; break; } }
    const durations = bin.durations[result];
    let duration = durations[Math.floor(random() * durations.length)];
    const trailing = frame.scores[frame.offense] < frame.scores[other(frame.offense)];
    // Residual-drive approximation, not a play-by-play model. Historical full-drive samples
    // are shortened for a partially completed drive and late-game urgency.
    if (first) duration *= Math.max(0.18, Math.min(1, (100 - own) / 75));
    if (seconds <= 180) duration *= trailing ? 0.30 : 0.55;
    if (first && seconds <= 120) {
      const timeouts = frame.offense === 'home' ? game.timeoutsHome : game.timeoutsAway;
      duration *= 1 - Math.min(2, timeouts) * 0.08;
    }
    duration = Math.max(3, Math.round(duration));
    // A play begun before 0:00 can score after the clock expires. Allow the
    // sampled final play a five-second overrun instead of guaranteeing a tie.
    if (duration > seconds + 5) { if (frame.completed.home + frame.completed.away === 0) branch = 'noScore'; break; }
    seconds = Math.max(0, seconds - duration);
    if (frame.completed.home + frame.completed.away === 0) branch = result === 'Touchdown' ? 'touchdown' : result === 'Field goal' ? 'fieldGoal' : 'noScore';
    if (resolveOvertimeDrive(frame, result, game.overtimeRules, random)) return { tied: false, branch };
    own = 30;
    first = false;
  }
  // Regular-season time expires even during the second team's initial possession.
  return { tied: frame.scores.home === frame.scores.away, branch };
}

// Score difference identifies the opening result only before the responder scores.
// Once both teams have possessed, use the provider's explicit opening-drive result.
function observedFirstDrive(game: BotGame): Branch | undefined {
  const context = game.overtime;
  if (!context) return undefined;
  if (context.firstDriveOutcome) return context.firstDriveOutcome;
  if (context.completed.home + context.completed.away !== 1 || context.completed[game.possession] !== 0) return undefined;
  const first = context.firstPossession;
  const lead = first === 'home' ? game.homeScore - game.awayScore : game.awayScore - game.homeScore;
  return lead >= 6 && lead <= 8 ? 'touchdown' : lead === 3 ? 'fieldGoal' : lead === 0 ? 'noScore' : undefined;
}

export function predictRawFinalTie(game: BotGame, runs = 10000): number | null {
  if (game.quarter <= 4) return null;
  if (game.seasonType === 'postseason' || game.overtimeRules === 'postseason') return 0;
  if (!game.isLive) return game.homeScore === game.awayScore ? 1 : 0;
  if (!game.overtime || game.fieldStateReliable !== true || game.phase !== 'scrimmage' || game.clockSeconds <= 0 || game.clockSeconds > 600) return null;
  if (!Number.isInteger(runs) || runs < 1) throw new Error('Invalid simulation run count');
  const seed = JSON.stringify([OT_MODEL_VERSION, game.id, game.homeScore, game.awayScore, game.clockSeconds, game.possession,
    game.down, game.distance, game.yardlineOwn, game.timeoutsHome, game.timeoutsAway, game.overtime, game.overtimeRules]);
  const random = randomFor(seed);
  let ties = 0;
  for (let run = 0; run < runs; run++) if (drawOnce(game, game.overtime, random).tied) ties++;
  return ties / runs;
}

type Cells = Record<Branch, { tie: number; win: number }>;
let reference: { weights: Cells; rawRate: number } | undefined;
function referenceCalibration(game: BotGame) {
  if (reference) return reference;
  const opening: BotGame = { ...game, id: 'ot-calibration-reference', homeScore: 0, awayScore: 0,
    quarter: 5, clockSeconds: 600, possession: 'home', down: 1, distance: 10, yardlineOwn: 30,
    timeoutsHome: 2, timeoutsAway: 2, phase: 'scrimmage', isLive: true, fieldStateReliable: true,
    overtimeRules: 'current_regular', seasonType: 'regular',
    overtime: { completed: { home: 0, away: 0 }, firstPossession: 'home', source: 'scenario' } };
  const counts: Cells = { touchdown: { tie: 0, win: 0 }, fieldGoal: { tie: 0, win: 0 }, noScore: { tie: 0, win: 0 } };
  const random = randomFor(`${OT_MODEL_VERSION}:reference`), samples = 100000;
  for (let i = 0; i < samples; i++) {
    const path = drawOnce(opening, opening.overtime!, random);
    counts[path.branch!][path.tied ? 'tie' : 'win']++;
  }
  const weights = {} as Cells;
  for (const b of branches) {
    if (!counts[b].tie || !counts[b].win) throw new Error('OT calibration has insufficient branch support');
    const target = FIRST_DRIVE_BRANCHES[b], mass = target.probability / branchTotal;
    weights[b] = { tie: mass * target.tieGivenOutcome / (counts[b].tie / samples),
      win: mass * (1 - target.tieGivenOutcome) / (counts[b].win / samples) };
  }
  reference = { weights, rawRate: branches.reduce((n, b) => n + counts[b].tie, 0) / samples };
  return reference;
}

export function predictFinalTie(game: BotGame, runs = 10000): number | null {
  const raw = predictRawFinalTie(game, runs);
  if (raw == null || raw === 0 || raw === 1 || game.overtimeRules !== 'current_regular' || !game.isLive) return raw;
  const ref = referenceCalibration(game);
  const completed = game.overtime!.completed.home + game.overtime!.completed.away;
  if (completed > 0 && !observedFirstDrive(game)) {
    // Older snapshots/manual sudden-death scenarios may lack opening-drive history.
    const factor = FRESH_OT_TIE_RATE / (1 - FRESH_OT_TIE_RATE) * (1 - ref.rawRate) / ref.rawRate;
    return raw * factor / (1 - raw + raw * factor);
  }
  // Importance-weight complete futures by (opening outcome, final result).
  // At fresh OT this matches all supplied joint branch probabilities. Later,
  // remaining time/field state still change the available simulated futures.
  const random = randomFor(JSON.stringify([OT_MODEL_VERSION, game.id, game.clockSeconds, game.homeScore, game.awayScore,
    game.possession, game.down, game.distance, game.yardlineOwn, game.timeoutsHome, game.timeoutsAway, game.overtime]));
  let tieWeight = 0, totalWeight = 0;
  for (let i = 0; i < runs; i++) {
    const path = drawOnce(game, game.overtime!, random);
    const weight = ref.weights[path.branch!][path.tied ? 'tie' : 'win'];
    totalWeight += weight;
    if (path.tied) tieWeight += weight;
  }
  return tieWeight / totalWeight;
}
