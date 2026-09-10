import { createHash } from 'node:crypto';
import { predictRegulationTie } from '../web/lib/model';
import type { GameState } from '../web/lib/types';
import type { BotConfig } from './config';

export interface Post {
  key: string;
  gameId: string;
  kind: 'forecast' | 'overtime' | 'final' | 'test';
  text: string;
  probability: number;
}
export interface PreviousPost { probability: number; created_at: number; kind: string }

export function nextPost(game: GameState, previous: PreviousPost | undefined, count: number, config: BotConfig, now: number): Post | null {
  if (game.source !== 'live' || game.seasonType === 'preseason' || count >= config.maxPostsPerGame) return null;
  const score = `${game.awayTeam} ${game.awayScore} - ${game.homeTeam} ${game.homeScore}`;
  let kind: Post['kind'];
  let text: string;
  let probability: number;
  if (game.quarter > 4) {
    if (previous?.kind === 'overtime' || previous?.kind === 'final') return null;
    // Confirmation doesn't depend on the current OT score being level.
    kind = 'overtime'; probability = 1;
    text = `${game.awayTeam} vs ${game.homeTeam}: ${game.isLive ? "We're going to overtime!" : 'Overtime confirmed.'}\n\nRegulation ended tied. #NFL #TieWon`;
  } else if (!game.isLive) {
    if (!previous || previous.kind !== 'forecast' || game.awayScore === game.homeScore) return null;
    kind = 'final'; probability = 0;
    text = `Final: ${score}\n\nNo overtime this time. #NFL #TieWon`;
  } else {
    if (game.quarter !== 4 || game.clockSeconds <= 0 || game.phase !== 'scrimmage' || (previous && previous.kind !== 'forecast')) return null;
    // Reserve one game slot for the outcome. No automatic repeats of the same forecast text.
    if (count >= config.maxPostsPerGame - 1) return null;
    probability = predictRegulationTie(game);
    if (!previous && probability < config.minProbability) return null;
    if (previous && (now - previous.created_at < config.cooldownSeconds * 1000 || Math.abs(probability - previous.probability) < config.minChange)) return null;
    kind = 'forecast';
    const percentage = Math.min(99.9, probability * 100).toFixed(1);
    text = `${score} | Q4 ${game.clockLabel}\n\nChance regulation ends tied: ${percentage}%\n\nTieWon model estimate via ESPN. #NFL #TieWon`;
  }
  const suffix = kind === 'forecast' ? createHash('sha256').update(text).digest('hex').slice(0, 24) : kind;
  return { key: `${game.id}:${suffix}`, gameId: game.id, kind, text, probability };
}
