import { pregameLines, type PregameLine } from './pregame';
import { ESPN_SCOREBOARD_URL, parseScoreboard } from './espn';
import type { BotGame } from './live-types';
import type { Possession } from './types';

export const ESPN_SUMMARY_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary';
type Obj = Record<string, unknown>;
const record = (v: unknown): Obj => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const list = (v: unknown): Obj[] => Array.isArray(v) ? v.map(record) : [];
function numeric(v: unknown, min: number, max: number) {
  return (typeof v === 'number' || typeof v === 'string' && v.trim() !== '') && Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max;
}
function seconds(v: unknown) {
  const match = String(v ?? '').match(/^(\d{1,2}):(\d{2})$/);
  return match && Number(match[2]) < 60 ? Number(match[1]) * 60 + Number(match[2]) : NaN;
}

export function botGames(payload: unknown, now = Date.now()): BotGame[] {
  const events = record(payload).events;
  if (!Array.isArray(events)) throw new Error('Invalid ESPN scoreboard: events missing');
  const games: BotGame[] = [];
  for (const raw of events) {
    const event = record(raw);
    const competition = list(event.competitions)[0];
    if (!competition) continue;
    const status = record(competition.status ?? event.status);
    const type = record(status.type);
    const season = record(event.season);
    const kickoff = Date.parse(String(event.date ?? ''));
    if (!Number.isFinite(kickoff) || kickoff > now || now - kickoff > 18 * 3600_000) continue;
    if (!/^\d+$/.test(String(event.id)) || !['regular-season', 'post-season'].includes(String(season.slug))) continue;
    if (!['in', 'post'].includes(String(type.state)) || !numeric(status.period, 1, 20)) continue;
    if (type.state === 'in' && !['STATUS_IN_PROGRESS', 'STATUS_END_PERIOD', 'STATUS_HALFTIME'].includes(String(type.name))) continue;
    if (type.state === 'post' && (type.completed !== true || type.name !== 'STATUS_FINAL')) continue;
    const competitors = list(competition.competitors);
    if (competitors.length !== 2 || !competitors.some(c => c.homeAway === 'home') || !competitors.some(c => c.homeAway === 'away')) continue;
    if (competitors.some(c => !numeric(c.score, 0, 200) || !/^[A-Z]{2,3}$/.test(String(record(c.team).abbreviation)))) continue;
    const situation = record(competition.situation);
    const field = String(situation.possessionText ?? '').match(/^([A-Z]{2,3})\s+(\d{1,2})$/);
    const reliable = numeric(status.clock, 0, Number(status.period) <= 4 ? 900 : 600)
      && (Number(status.clock) > 0 || Number(status.period) < 4)
      && competitors.some(c => c.id != null && String(c.id) === String(situation.possession))
      && numeric(situation.down, 1, 4) && numeric(situation.distance, 0, 99)
      && numeric(situation.homeTimeouts, 0, 3) && numeric(situation.awayTimeouts, 0, 3)
      && Boolean(field && Number(field[2]) <= 50 && competitors.some(c => record(c.team).abbreviation === field[1]))
      && !(/touchdown/i.test(String(record(situation.lastPlay).text)) && !/(extra point|two-point|conversion)/i.test(String(record(situation.lastPlay).text)));
    const normalized = { ...event, competitions: [{ ...competition, status: { ...status, type: { ...type, state: 'in' } } }] };
    const game = parseScoreboard({ events: [normalized] })[0];
    if (game) games.push({ ...game, providerPeriod: Number(status.period), startTime: String(event.date), fieldStateReliable: reliable,
      isLive: type.state === 'in', clockLabel: `${Math.floor(game.clockSeconds / 60)}:${String(game.clockSeconds % 60).padStart(2, '0')}` });
  }
  return games;
}

export function attachOvertimeContext(game: BotGame, payload: unknown): BotGame {
  if (!game.isLive || game.quarter <= 4 || game.fieldStateReliable !== true || game.seasonType === 'postseason') return game;
  const header = record(record(payload).header);
  if (String(header.id) !== game.id) return game;
  const competition = list(header.competitions)[0] ?? {};
  if (record(record(competition.status).type).completed === true) return game;
  for (const side of ['home', 'away'] as const) {
    const competitor = list(competition.competitors).find(c => c.homeAway === side);
    if (!competitor || record(competitor.team).abbreviation !== (side === 'home' ? game.homeTeam : game.awayTeam)
      || !numeric(competitor.score, 0, 200) || Number(competitor.score) !== (side === 'home' ? game.homeScore : game.awayScore)) return game;
  }
  const drives = record(record(payload).drives);
  const current = record(drives.current);
  const previous = list(drives.previous).filter(d => String(d.id) !== String(current.id) && Number(record(record(d.start).period).number) === 5);
  if (!current.id || Number(record(record(current.start).period).number) !== 5) return game;
  const all = [...previous, current];
  const sideOf = (d: Obj): Possession | null => record(d.team).abbreviation === game.homeTeam ? 'home' : record(d.team).abbreviation === game.awayTeam ? 'away' : null;
  const first = sideOf(all[0]);
  if (!first || seconds(record(record(all[0].start).clock).displayValue) !== 600 || sideOf(current) !== game.possession) return game;
  if (new Set(all.map(d => String(d.id))).size !== all.length || all.some(d => !sideOf(d))) return game;
  if (previous.some(d => !d.result || !Object.keys(record(d.end)).length)) return game;
  // Drive lists cannot reliably account for every opportunity on unusual kicking plays.
  if (all.some(d => list(d.plays).some(p => /onside|muff/i.test(String(p.text))))) return game;
  const last = list(current.plays).at(-1);
  if (!last || Number(record(last.period).number) !== 5 || Number(last.homeScore) !== game.homeScore || Number(last.awayScore) !== game.awayScore) return game;
  const playClock = seconds(record(last.clock).displayValue);
  if (!Number.isFinite(playClock) || playClock < game.clockSeconds || playClock - game.clockSeconds > 60) return game;
  const completed = { home: 0, away: 0 };
  previous.forEach(d => completed[sideOf(d)!]++);
  return { ...game, overtime: { completed, firstPossession: first, source: 'espn-drives' } };
}

async function getJson(url: string, request: typeof fetch) {
  const response = await request(url, { signal: AbortSignal.timeout(15000), cache: 'no-store', redirect: 'error' });
  if (!response.ok) throw new Error(`ESPN returned HTTP ${response.status}`);
  const age = Number(response.headers.get('age') ?? 0);
  if (!Number.isFinite(age) || age > 120) throw new Error('ESPN returned a stale cached response');
  return response.json();
}
export async function fetchGames(now = Date.now(), request: typeof fetch = fetch, capturePregame?: (lines: PregameLine[]) => void): Promise<BotGame[]> {
  const date = (time: number) => new Date(time).toISOString().slice(0, 10).replaceAll('-', '');
  const payload = await getJson(`${ESPN_SCOREBOARD_URL}?dates=${date(now - 86400000)}-${date(now)}&limit=100`, request);
  capturePregame?.(pregameLines(payload, now));
  return Promise.all(botGames(payload, now).map(async game => {
    if (!game.isLive || game.quarter <= 4 || game.seasonType === 'postseason' || !game.fieldStateReliable) return game;
    try { return attachOvertimeContext(game, await getJson(`${ESPN_SUMMARY_URL}?event=${game.id}`, request)); }
    catch { return game; } // OT confirmation still posts; incomplete forecasts are withheld.
  }));
}
