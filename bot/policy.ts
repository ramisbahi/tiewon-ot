import type { BotGame, GameHistory } from './types';
import type { Probabilities } from '../web/lib/live-probabilities';

export const MILESTONES = [0.20, 0.50, 0.75, 0.90] as const;
export interface Post {
  key: string;
  gameId: string;
  kind: 'kickoff' | 'quarter' | 'welcome' | 'halftime' | 'q4_threshold' | 'ot_threshold' | 'overtime' | 'final' | 'test';
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

  // Provider-confirmed outcomes override probability and forecast budgets.
  if (!game.isLive) {
    if (!isOT && !history.followed) return null;
    const tied = game.awayScore === game.homeScore;
    if (tied && (!isOT || game.seasonType === 'postseason')) return null;
    const winner = game.homeScore > game.awayScore ? game.homeTeam : game.awayTeam;
    const pct = (p: number | null | undefined) => p == null || !Number.isFinite(p) ? 'unavailable' : `${(p * 100).toFixed(1)}%`;
    const peaks = `Peak forecasts observed:\nFinal tie: ${pct(history.peakTie)}\nOT (before OT): ${pct(history.peakOvertime)}`;
    const text = tied
      ? `🚨🚨🚨 IT'S A TIE!!! 🚨🚨🚨\n🎉🎉🎉 NOBODY WINS. TIEWON WINS! 🏆🤝\nTieWatch 🇹🇭⌚️: MISSION ACCOMPLISHED ‼️\n\n${score} | FINAL / OT\n\n${peaks}\n\n${hash}`
      : isOT
        ? `TIE WATCH OVER.\n\n${score}\n${winner} wins in overtime.\n\n${peaks}\n\n${hash}`
        : `NO OVERTIME.\n\n${score}\nFinal. ${winner} closes it out in regulation.\n\n${peaks}\n\n${hash}`;
    return { ...base, key: `${game.id}:final`, kind: 'final', probability: tied ? 1 : 0, text };
  }

  if (isOT && !history.overtimeAnnounced) {
    const watch = game.seasonType === 'postseason'
      ? 'Postseason: this game cannot finish tied.'
      : validProbability
        ? `Chance of a FINAL TIE: ${percent}\nSimulation estimate.${milestone ? ` Above ${crossing}.` : ''}`
        : 'Now watching for a final tie.';
    return { ...base, key: `${game.id}:overtime`, kind: 'overtime', probability: validProbability ? probability : null, milestone,
      text: `🚨🚨🚨 ‼️ NUCLEAR TieWatch 🇹🇭⌚️ ‼️ 🚨🚨🚨\n\nOVERTIME! End of Q4.\n${score}\n\n${watch}\n\n${hash}` };
  }
  if (game.quarter === 1 && game.status === 'STATUS_IN_PROGRESS' && game.clockSeconds > 0 && !history.kickoffAnnounced) {
    const p = game.kickoffForecast ?? probabilities;
    const pct = (v: number | null | undefined) => v == null ? 'unavailable' : `${(v*100).toFixed(2)}%`;
    const start = game.kickoffForecast ? 'KICKOFF! 🏈 Now tracking' : `NOW TRACKING 🏈 Q1 ${game.clockLabel}`;
    const basis = game.kickoffForecast ? `Kickoff model: ${game.kickoffForecast.basis}.` : 'Joined after kickoff. Current model estimates.';
    return { ...base, key: `${game.id}:kickoff`, kind: 'kickoff', probability: p?.finalTie ?? null,
      text: `${start} ${game.awayTeam} vs ${game.homeTeam}\n\nChance of a FINAL TIE: ${pct(p?.finalTie)}\nChance of OVERTIME: ${pct(p?.overtime)}\n\n${basis}\nTieWatch 🇹🇭⌚️ ${hash}` };
  }
  const update = history.quarterUpdate ?? (game.status === 'STATUS_HALFTIME' && !history.halftimeAnnounced
    ? { quarter: 2, game, probabilities: probabilities ?? { overtime: probability, finalTie: null }, boundary: true } : undefined);
  if (!isOT && update) {
    const pct = (p: number | null) => p == null || !Number.isFinite(p) ? 'unavailable' : `${(p * 100).toFixed(1)}%`;
    const g = update.game;
    const heading = update.quarter === 2 ? 'HALFTIME / END OF Q2' : `END OF Q${update.quarter}`;
    const timing = update.boundary ? '' : `\nLatest: Q${g.quarter} ${g.clockLabel} (break missed).`;
    return { ...base, key: update.quarter === 2 ? `${game.id}:halftime` : `${game.id}:quarter:${update.quarter}`,
      kind: update.quarter === 2 ? 'halftime' : 'quarter', probability: update.probabilities.overtime,
      text: `${heading}\n\n${g.awayTeam} ${g.awayScore} - ${g.homeTeam} ${g.homeScore}${timing}\nChance of a FINAL TIE: ${pct(update.probabilities.finalTie)}\nChance of OVERTIME: ${pct(update.probabilities.overtime)}\n\nModel estimates. ${hash}` };
  }
  if (!validProbability || !milestone || game.clockSeconds <= 0 || game.phase !== 'scrimmage' || game.fieldStateReliable === false) return null;
  if (!isOT && (game.quarter !== 4 || history.overtimeAnnounced)) return null;
  if (isOT && game.seasonType === 'postseason') return null;
  return { ...base, key: `${game.id}:${isOT ? 'tie' : 'ot'}:${Math.round(milestone * 100)}`,
    kind: isOT ? 'ot_threshold' : 'q4_threshold', probability, milestone,
    text: `${isOT ? 'TIE' : 'OVERTIME'} WATCH: above ${crossing}.\n\n${score} | ${isOT ? 'OT' : 'Q4'} ${game.clockLabel}\n${isOT ? 'Chance of a FINAL TIE' : 'Chance of OVERTIME'}: ${percent}\n\n${isOT ? 'Simulation' : 'Model'} estimate. ${hash}` };
}
