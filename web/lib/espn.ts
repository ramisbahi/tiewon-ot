import type { GameState, Possession } from './types';

interface ESPNCompetitor {
  id?: string | number;
  homeAway?: 'home' | 'away';
  score?: string | number;
  team?: { abbreviation?: string };
}

interface ESPNEvent {
  id?: string | number;
  season?: { slug?: string; year?: string | number };
  status?: ESPNStatus;
  competitions?: Array<{
    status?: ESPNStatus;
    competitors?: ESPNCompetitor[];
    situation?: ESPNSituation;
  }>;
}

interface ESPNStatus {
  period?: string | number;
  clock?: string | number;
  displayClock?: string;
  type?: { state?: string; name?: string; shortDetail?: string; detail?: string };
}

interface ESPNSituation {
  possession?: string | number;
  possessionText?: string;
  down?: string | number;
  distance?: string | number;
  yardLine?: string | number;
  homeTimeouts?: string | number;
  awayTimeouts?: string | number;
  lastPlay?: { text?: string };
}

export const ESPN_SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

function integer(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ownYardLine(possessionAbbr: string, possessionText: string, fallback: number) {
  const match = possessionText.match(/^([A-Z]{2,3})\s+(\d{1,2})$/);
  if (!match) return Math.min(99, Math.max(1, fallback));
  const yard = integer(match[2], 25);
  return Math.min(99, Math.max(1, match[1] === possessionAbbr ? yard : 100 - yard));
}

function parseEvent(event: ESPNEvent): GameState | null {
  const competition = event?.competitions?.[0];
  const status = competition?.status ?? event?.status;
  if (!competition || status?.type?.state !== 'in') return null;
  const competitors = competition.competitors ?? [];
  const home = competitors.find((team) => team.homeAway === 'home');
  const away = competitors.find((team) => team.homeAway === 'away');
  if (!home || !away) return null;
  const situation = competition.situation ?? {};
  const possessionId = String(situation.possession ?? '');
  const possession: Possession = String(home.id) === possessionId ? 'home' : 'away';
  const possessionTeam = possession === 'home' ? home : away;
  const possessionAbbr = possessionTeam.team?.abbreviation ?? '';
  const seasonSlug = String(event?.season?.slug ?? 'regular');
  const seasonType = seasonSlug.includes('post') ? 'postseason' : seasonSlug.includes('pre') ? 'preseason' : 'regular';
  const seasonYear = integer(event?.season?.year, new Date().getFullYear());
  const lastPlayText = String(situation.lastPlay?.text ?? '');
  const phase = /touchdown/i.test(lastPlayText) && !/(extra point|two-point|conversion)/i.test(lastPlayText) && integer(situation.down, 0) === 0
    ? 'pending_try'
    : 'scrimmage';

  return {
    id: String(event.id), awayTeam: away.team?.abbreviation ?? 'AWY', homeTeam: home.team?.abbreviation ?? 'HME',
    awayScore: integer(away.score, 0), homeScore: integer(home.score, 0),
    quarter: Math.min(5, Math.max(1, integer(status?.period, 1))),
    clockSeconds: Math.max(0, integer(status?.clock, 0)), clockLabel: String(status?.displayClock ?? '0:00'),
    possession, phase, tryType: 'kick', pendingTryTeam: possession,
    overtimeRules: seasonType === 'postseason' ? 'postseason' : seasonYear >= 2025 ? 'current_regular' : 'legacy_regular',
    down: Math.min(4, Math.max(1, integer(situation.down, 1))),
    distance: Math.min(30, Math.max(1, integer(situation.distance, 10))),
    yardlineOwn: ownYardLine(possessionAbbr, String(situation.possessionText ?? ''), integer(situation.yardLine, 25)),
    timeoutsHome: Math.min(3, Math.max(0, integer(situation.homeTimeouts, 3))),
    timeoutsAway: Math.min(3, Math.max(0, integer(situation.awayTimeouts, 3))),
    status: status?.type?.name ?? 'STATUS_IN_PROGRESS', detail: status?.type?.shortDetail ?? status?.type?.detail ?? 'Live',
    isLive: true, seasonType, source: 'live',
  };
}

export function parseScoreboard(payload: unknown): GameState[] {
  const events = (payload as { events?: ESPNEvent[] } | null)?.events ?? [];
  return events.map(parseEvent).filter((game: GameState | null): game is GameState => Boolean(game));
}
