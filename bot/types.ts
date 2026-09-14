export type { BotGame, OvertimeContext } from '../web/lib/live-types';
import type { Probabilities } from '../web/lib/live-probabilities';
import type { BotGame } from '../web/lib/live-types';
export interface QuarterUpdate { quarter: number; game: BotGame; probabilities: Probabilities; boundary: boolean }
export interface GameHistory {
  quarterUpdate?: QuarterUpdate;
  peakTie?: number | null;
  peakOvertime?: number | null;
  q4Milestone: number;
  otMilestone: number;
  overtimeAnnounced: boolean;
  halftimeAnnounced: boolean;
  finalized: boolean;
  followed: boolean;
  lastTweetId?: string;
}
export const EMPTY_HISTORY: GameHistory = {
  q4Milestone: 0, otMilestone: 0, overtimeAnnounced: false, halftimeAnnounced: false, finalized: false, followed: false,
};
