import type { BotGame, GameHistory } from './types';
import type { Probabilities } from '../web/lib/live-probabilities';

export const MILESTONES = [0.20, 0.50, 0.75, 0.90] as const;
export interface Post {
  key: string;
  gameId: string;
  kind: 'halftime' | 'q4_threshold' | 'ot_threshold' | 'overtime' | 'final' | 'test';
  text: string;
  probability: number | null;
  milestone?: number;
  replyTo?: string;
}

export function nextPost(game: BotGame, history: GameHistory, probability: number | null, probabilities?: Probabilities): Post | null {
  if (game.source !== 'live' || game.seasonType === 'preseason' || history.finalized) return null;
  const score = `${game.awayTeam} ${game.awayScore} - ${game.homeTeam} ${game.homeScore}`;
  const hash = `#${game.awayTeam}vs${game.homeTeam} #TieWon`;
  const validProbability = probability !== null && Number.isFinite(probability) && probability >= 0 && probability <= 1;
  const percent = validProbability ? `${Math.min(99.9, probability! * 100).toFixed(1)}%` : '';
  const isOT = game.quarter > 4;
  const crossed = validProbability ? MILESTONES.filter((level) => probability! > level && level > (isOT ? history.otMilestone : history.q4Milestone)) : [];
  const milestone = crossed.at(-1);
  const crossing = crossed.map((level) => `${Math.round(level * 100)}%`).join(' / ');
  const base = { gameId: game.id, replyTo: history.lastTweetId };

  if (game.isLive && game.status === 'STATUS_HALFTIME' && !history.halftimeAnnounced) {
    const pct = (p: number | null | undefined) => p == null ? 'unavailable' : `${(p * 100).toFixed(1)}%`;
    return { ...base, key: `${game.id}:halftime`, kind: 'halftime', probability,
      text: `HALFTIME.\n\n${score}\nChance of a FINAL TIE: ${pct(probabilities?.finalTie)}\nChance of OVERTIME: ${pct(probabilities?.overtime ?? probability)}\n\nModel estimates for the second half. ${hash}` };
  }

  // Provider-confirmed outcomes override probability and forecast budgets.
  if (!game.isLive) {
    if (!isOT && !history.followed) return null;
    const tied = game.awayScore === game.homeScore;
    if (tied && (!isOT || game.seasonType === 'postseason')) return null;
    const winner = game.homeScore > game.awayScore ? game.homeTeam : game.awayTeam;
    const text = tied
      ? `IT'S A TIE.\n\n${score}\nFinal / OT. No winner. TieWon.\n\n${hash}`
      : isOT
        ? `TIE WATCH OVER.\n\n${score}\n${winner} wins in overtime.\n\n${hash}`
        : `NO OVERTIME.\n\n${score}\nFinal. ${winner} closes it out in regulation.\n\n${hash}`;
    return { ...base, key: `${game.id}:final`, kind: 'final', probability: tied ? 1 : 0, text };
  }

  if (isOT && !history.overtimeAnnounced) {
    const watch = game.seasonType === 'postseason'
      ? 'Postseason: this game cannot finish tied.'
      : validProbability
        ? `Chance of a FINAL TIE: ${percent}\nSimulation estimate.${milestone ? ` Above ${crossing}.` : ''}`
        : 'Now watching for a final tie.';
    return { ...base, key: `${game.id}:overtime`, kind: 'overtime', probability: validProbability ? probability : null, milestone,
      text: `OVERTIME!\n\n${game.awayTeam} vs ${game.homeTeam} went the distance. Regulation ended tied.\n\n${watch}\n\n${hash}` };
  }
  if (!validProbability || !milestone || game.clockSeconds <= 0 || game.phase !== 'scrimmage' || game.fieldStateReliable === false) return null;
  if (!isOT && (game.quarter !== 4 || history.overtimeAnnounced)) return null;
  if (isOT && game.seasonType === 'postseason') return null;
  return { ...base, key: `${game.id}:${isOT ? 'tie' : 'ot'}:${Math.round(milestone * 100)}`,
    kind: isOT ? 'ot_threshold' : 'q4_threshold', probability, milestone,
    text: `${isOT ? 'TIE' : 'OVERTIME'} WATCH: above ${crossing}.\n\n${score} | ${isOT ? 'OT' : 'Q4'} ${game.clockLabel}\n${isOT ? 'Chance of a FINAL TIE' : 'Chance of OVERTIME'}: ${percent}\n\n${isOT ? 'Simulation' : 'Model'} estimate. ${hash}` };
}
