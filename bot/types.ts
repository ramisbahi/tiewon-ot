export type { BotGame, OvertimeContext } from '../web/lib/live-types';
export interface GameHistory {
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
