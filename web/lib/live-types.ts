import type { GameState, Possession } from './types';

export interface OvertimeContext {
  completed: Record<Possession, number>;
  firstPossession: Possession;
  source: 'espn-drives' | 'scenario';
}
export interface BotGame extends GameState {
  kickoffForecast?: { modelVersion: string; overtime: number; finalTie: number; basis: string };
  fieldStateReliable?: boolean;
  overtime?: OvertimeContext;
  providerPeriod?: number;
  startTime?: string;
}
