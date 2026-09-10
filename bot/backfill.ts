import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { snapshot, type Snapshot } from '../web/lib/history';
import { liveProbabilities } from '../web/lib/live-probabilities';
import type { BotGame } from './types';

interface Play {
  id: string; sequenceNumber: string; text: string; type: { text: string };
  period: { number: number }; clock: { displayValue: string }; wallclock: string;
  homeScore: number; awayScore: number;
  start: { down: number; distance: number; possessionText?: string; team?: { id: string } };
}
interface Summary {
  header: { id: string; season: { year: number; type: number }; competitions: Array<{
    date?: string; status: { type: { completed: boolean } };
    competitors: Array<{ id: string; homeAway: string; score: string; team: { abbreviation: string } }>;
  }> };
  drives: { previous: Array<{ plays: Play[] }> };
}

// Offline reconstruction only. This module never imports the publisher or X client.
// Use each play's START field state with the PREVIOUS play's score, never its result.
export function reconstructSummary(payload: unknown, reconstructedAt = Date.now()): Snapshot[] {
  const data = payload as Summary;
  const competition = data.header.competitions[0];
  if (!competition.status.type.completed) throw new Error('Backfill requires a confirmed final');
  const home = competition.competitors.find(c => c.homeAway === 'home')!;
  const away = competition.competitors.find(c => c.homeAway === 'away')!;
  const plays = [...new Map(data.drives.previous.flatMap(d => d.plays).map(p => [p.id, p])).values()]
    .sort((a, b) => Number(a.sequenceNumber) - Number(b.sequenceNumber));
  if (!plays.length || plays[0].period.number !== 1 || plays[0].clock.displayValue !== '15:00') throw new Error('Incomplete opening play history');
  if (plays.some(p => p.period.number > 4)) throw new Error('This backfill command supports regulation games only');
  let homeScore = 0; let awayScore = 0; let half = 1;
  let timeoutsHome = 3; let timeoutsAway = 3;
  const output: Snapshot[] = [];
  for (const p of plays) {
    const quarter = p.period.number;
    if (quarter >= 3 && half === 1) { half = 2; timeoutsHome = 3; timeoutsAway = 3; }
    const observedAt = Date.parse(p.wallclock);
    const clock = /^(\d{1,2}):(\d{2})$/.exec(p.clock.displayValue);
    if (!Number.isFinite(observedAt) || !clock) throw new Error('Missing play timestamp or clock');
    const clockSeconds = Number(clock[1]) * 60 + Number(clock[2]);
    const possession = p.start.team?.id === home.id ? 'home' : 'away';
    const field = /^([A-Z]{2,3}) (\d{1,2})$/.exec(p.start.possessionText ?? '');
    const offense = possession === 'home' ? home.team.abbreviation : away.team.abbreviation;
    const reliable = [home.id, away.id].includes(p.start.team?.id ?? '') && p.start.down >= 1 && p.start.down <= 4
      && Boolean(field && [home.team.abbreviation, away.team.abbreviation].includes(field[1]) && Number(field[2]) <= 50)
      && Number.isFinite(p.start.distance) && p.start.distance >= 0 && clockSeconds > 0;
    const finished = p.type.text === 'End of Game';
    const game: BotGame = {
      id: data.header.id, startTime: competition.date, homeTeam: home.team.abbreviation, awayTeam: away.team.abbreviation,
      homeScore: finished ? Number(home.score) : homeScore, awayScore: finished ? Number(away.score) : awayScore,
      quarter, providerPeriod: quarter, clockSeconds, clockLabel: p.clock.displayValue, possession,
      down: reliable ? p.start.down : 1, distance: reliable ? p.start.distance : 10,
      yardlineOwn: field ? field[1] === offense ? Number(field[2]) : 100 - Number(field[2]) : 25,
      timeoutsHome, timeoutsAway, phase: 'scrimmage', tryType: 'kick', pendingTryTeam: possession,
      overtimeRules: data.header.season.type === 3 ? 'postseason' : data.header.season.year >= 2025 ? 'current_regular' : 'legacy_regular',
      seasonType: data.header.season.type === 3 ? 'postseason' : 'regular', source: 'live', isLive: !finished,
      fieldStateReliable: reliable, status: finished ? 'STATUS_FINAL' : 'STATUS_IN_PROGRESS', detail: 'Reconstructed pre-play state',
    };
    const sample = snapshot(game, liveProbabilities(game), observedAt);
    output.push({ ...sample, id: `${game.id}:replay:${p.id}`, origin: 'reconstructed', playId: p.id, reconstructedAt });
    // Scores in ESPN plays are post-play. Advance only after the pre-play estimate.
    homeScore = p.homeScore; awayScore = p.awayScore;
    const timeout = /Timeout #(\d) by ([A-Z]{2,3})/.exec(p.text);
    if (timeout?.[2] === home.team.abbreviation) timeoutsHome = Math.max(0, 3 - Number(timeout[1]));
    if (timeout?.[2] === away.team.abbreviation) timeoutsAway = Math.max(0, 3 - Number(timeout[1]));
  }
  if (output.at(-1)?.game.isLive) throw new Error('Missing final play');
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: backfill.ts SUMMARY_JSON OUTPUT_JSON');
  const samples = reconstructSummary(JSON.parse(readFileSync(input, 'utf8')));
  writeFileSync(output, JSON.stringify(samples));
  console.log(JSON.stringify({ gameId: samples[0].gameId, snapshots: samples.length, output, origin: 'reconstructed', postsSent: 0 }));
}
