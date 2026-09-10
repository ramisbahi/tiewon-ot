import { ESPN_SCOREBOARD_URL, parseScoreboard } from '../web/lib/espn';
import type { GameState } from '../web/lib/types';

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}
function numeric(value: unknown, min: number, max: number) {
  return (typeof value === 'string' && value.trim() !== '' || typeof value === 'number')
    && Number.isFinite(Number(value)) && Number(value) >= min && Number(value) <= max;
}

// The website may fill absent fields for exploration. Public posts require complete live inputs.
export function botGames(payload: unknown, now = Date.now()): GameState[] {
  const events = record(payload).events;
  if (!Array.isArray(events)) throw new Error('Invalid ESPN scoreboard: events missing');
  const games: GameState[] = [];
  for (const raw of events) {
    const event = record(raw);
    const competition = record(Array.isArray(event.competitions) ? event.competitions[0] : null);
    const status = record(competition.status ?? event.status);
    const type = record(status.type);
    const season = record(event.season);
    const kickoff = Date.parse(String(event.date ?? ''));
    if (!Number.isFinite(kickoff) || kickoff > now || now - kickoff > 18 * 3600_000) continue;
    if (!/^\d+$/.test(String(event.id)) || !['regular-season', 'post-season'].includes(String(season.slug))) continue;
    if (!['in', 'post'].includes(String(type.state))) continue;
    if (!numeric(status.period, 4, 20)) continue;
    if (type.state === 'in' && !['STATUS_IN_PROGRESS', 'STATUS_END_PERIOD'].includes(String(type.name))) continue;
    if (type.state === 'post' && type.completed !== true) continue;
    const competitors = Array.isArray(competition.competitors) ? competition.competitors.map(record) : [];
    if (competitors.length !== 2 || !competitors.some((c) => c.homeAway === 'home') || !competitors.some((c) => c.homeAway === 'away')) continue;
    if (competitors.some((c) => !numeric(c.score, 0, 200) || !/^[A-Z]{2,3}$/.test(String(record(c.team).abbreviation)))) continue;
    const situation = record(competition.situation);
    if (Number(status.period) === 4 && type.state === 'in') {
      if (!numeric(status.clock, 1, 900)) continue; // Wait for confirmed OT/final at 0:00 (untimed downs/tries).
      if (!competitors.some((c) => c.id != null && String(c.id) === String(situation.possession))) continue;
      if (!numeric(situation.down, 1, 4) || !numeric(situation.distance, 0, 99)) continue;
      if (!numeric(situation.homeTimeouts, 0, 3) || !numeric(situation.awayTimeouts, 0, 3)) continue;
      if (!/^[A-Z]{2,3}\s+\d{1,2}$/.test(String(situation.possessionText))) continue;
      // Don't guess kick vs. two-point intent from an incomplete touchdown update.
      if (/touchdown/i.test(String(record(situation.lastPlay).text)) && !/(extra point|two-point|conversion)/i.test(String(record(situation.lastPlay).text))) continue;
    }
    const normalized = { ...event, competitions: [{ ...competition, status: { ...status, type: { ...type, state: 'in' } } }] };
    const game = parseScoreboard({ events: [normalized] })[0];
    if (game) games.push({ ...game, isLive: type.state === 'in', clockLabel: `${Math.floor(game.clockSeconds / 60)}:${String(game.clockSeconds % 60).padStart(2, '0')}` });
  }
  return games;
}

export async function fetchGames(now = Date.now(), request: typeof fetch = fetch) {
  // Include yesterday for games crossing UTC midnight, but reject historical events above.
  const date = (time: number) => new Date(time).toISOString().slice(0, 10).replaceAll('-', '');
  const url = `${ESPN_SCOREBOARD_URL}?dates=${date(now - 86400_000)}-${date(now)}&limit=100`;
  const response = await request(url, { signal: AbortSignal.timeout(15_000), cache: 'no-store' });
  if (!response.ok) throw new Error(`ESPN returned HTTP ${response.status}`);
  const age = Number(response.headers.get('age') ?? 0);
  if (!Number.isFinite(age) || age > 120) throw new Error('ESPN returned a stale cached scoreboard');
  return botGames(await response.json(), now);
}
