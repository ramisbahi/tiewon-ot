import type { GameState, Possession } from './types';

export interface OvertimeContext {
  completed: Record<Possession, number>;
  firstPossession: Possession;
  source: 'espn-drives';
}
export interface BotGame extends GameState {
  fieldStateReliable?: boolean;
  overtime?: OvertimeContext;
  providerPeriod?: number;
  startTime?: string;
}
