export type Possession = 'home' | 'away';

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

