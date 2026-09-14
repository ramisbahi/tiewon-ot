import type { BotGame, QuarterUpdate } from './types';
import type { Probabilities } from '../web/lib/live-probabilities';

// Q4 is covered by the final recap or the OT announcement. No fake catch-up
// quarters after an outage: capture only a confirmed boundary or direct transition.
export function quarterUpdate(game: BotGame, probabilities: Probabilities, previous?: BotGame): QuarterUpdate | null {
  if (game.source !== 'live' || !game.isLive || game.seasonType === 'preseason') return null;
  const boundary = game.status === 'STATUS_HALFTIME'
    || game.status === 'STATUS_END_PERIOD' && game.clockSeconds === 0;
  const quarter = game.status === 'STATUS_HALFTIME' ? 2
    : boundary ? game.quarter
    : previous?.isLive && game.quarter === previous.quarter + 1 ? previous.quarter : 0;
  if (quarter < 1 || quarter > 3) return null;
  return { quarter, game, probabilities, boundary };
}
