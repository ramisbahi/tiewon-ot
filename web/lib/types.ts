export type Possession = 'home' | 'away';
export type GamePhase = 'scrimmage' | 'pending_try';
export type TryType = 'kick' | 'two_point';
export type OvertimeRules = 'legacy_regular' | 'current_regular' | 'postseason';

export interface GameState {
  id: string;
  awayTeam: string;
  homeTeam: string;
  awayScore: number;
  homeScore: number;
  quarter: number;
  clockSeconds: number;
  clockLabel: string;
  possession: Possession;
  phase: GamePhase;
  tryType: TryType;
  pendingTryTeam: Possession;
  overtimeRules: OvertimeRules;
  down: number;
  distance: number;
  yardlineOwn: number;
  timeoutsHome: number;
  timeoutsAway: number;
  status: string;
  detail: string;
  isLive: boolean;
  seasonType: 'preseason' | 'regular' | 'postseason';
  source?: 'live' | 'demo';
}

export interface GameFeedResponse {
  games: GameState[];
  fetchedAt: string;
  source: string;
}
