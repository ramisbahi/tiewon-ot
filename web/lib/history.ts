import type { BotGame } from './live-types';
import { LIVE_MODEL_VERSION, type Probabilities } from './live-probabilities';
export interface Snapshot {
  id: string;
  gameId: string;
  observedAt: number;
  modelVersion: string;
  origin: 'live' | 'reconstructed';
  playId?: string;
  reconstructedAt?: number;
  game: BotGame;
  probabilities: Probabilities;
}
function snapshotId(game: BotGame, time: number) {
  if (!game.isLive) return `${game.id}:final:${game.homeScore}:${game.awayScore}`;
  return `${game.id}:${Math.floor(time / 15000)}:${game.quarter}:${game.clockSeconds}:${game.homeScore}:${game.awayScore}:${game.isLive ? 'live' : 'final'}`;
}
export function snapshot(game: BotGame, probabilities: Probabilities, observedAt: number): Snapshot {
  return { id: snapshotId(game, observedAt), gameId: game.id, observedAt, modelVersion: LIVE_MODEL_VERSION, origin: 'live', game, probabilities };
}
export function validSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== 'object') return false;
  const s = value as Snapshot;
  const g = s.game;
  return Boolean(g && g.source === 'live' && /^\d+$/.test(s.gameId) && g.id === s.gameId
    && Number.isFinite(s.observedAt) && s.observedAt > 0 && s.observedAt <= Date.now() + 60000
    && (s.origin === 'live' && s.id === snapshotId(g, s.observedAt)
      || s.origin === 'reconstructed' && /^\d+$/.test(s.playId ?? '') && s.id === `${s.gameId}:replay:${s.playId}` && Number.isFinite(s.reconstructedAt))
    && typeof s.modelVersion === 'string' && s.modelVersion.length <= 150
    && /^[A-Z]{2,3}$/.test(g.homeTeam) && /^[A-Z]{2,3}$/.test(g.awayTeam)
    && ['regular', 'postseason'].includes(g.seasonType) && typeof g.isLive === 'boolean'
    && [g.homeScore, g.awayScore].every(v => Number.isInteger(v) && v >= 0 && v <= 200)
    && Number.isInteger(g.quarter) && g.quarter >= 1 && g.quarter <= 5
    && Number.isFinite(g.clockSeconds) && g.clockSeconds >= 0 && g.clockSeconds <= 900
    && s.probabilities && [s.probabilities.overtime, s.probabilities.finalTie].every(p => p === null || typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1));
}
