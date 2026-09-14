import baseline from './pregame-baseline.json';
import { FRESH_OT_TIE_RATE } from './ot-model';
import type { BotGame } from './live-types';
export interface PregameLine {
  gameId: string; homeTeam: string; awayTeam: string; spread: number;
  capturedAt: number; kickoffAt: number; source: 'espn-pregame-spread';
}
export function kickoffEstimate(game: BotGame, line?: PregameLine) {
  const valid = line && line.gameId === game.id && line.homeTeam === game.homeTeam && line.awayTeam === game.awayTeam
    && Number.isFinite(line.spread) && Math.abs(line.spread)<=40
    && line.capturedAt < line.kickoffAt && line.kickoffAt-line.capturedAt<=24*3600000
    && line.kickoffAt === Date.parse(game.startTime ?? '');
  const overtime = valid ? baseline.bins.find(b=>Math.abs(line.spread)<=b.maxSpread)!.probability : baseline.baseline;
  return { overtime, finalTie: game.seasonType === 'postseason' ? 0 : overtime*FRESH_OT_TIE_RATE,
    basis: valid ? 'pregame spread + historical OT rates' : 'historical average; pregame odds unavailable' };
}
// Accept prices only while ESPN explicitly reports the event as not started.
export function pregameLines(payload: unknown, now: number): PregameLine[] {
  const events = (payload as {events?: unknown[]})?.events;
  if (!Array.isArray(events)) return [];
  return events.flatMap(raw => {
    const e = raw as {id?:string; date?:string; season?:{slug?:string}; competitions?: Array<{status?:{type?:{state?:string;name?:string}}; competitors?:Array<{homeAway?:string;score?:string;team?:{abbreviation?:string}}>;odds?:Array<{spread?:number}>}>};
    const c=e?.competitions?.[0], kickoffAt=Date.parse(e?.date ?? '');
    if (!c || c.status?.type?.state!=='pre' || c.status.type.name!=='STATUS_SCHEDULED'
      || !['regular-season','post-season'].includes(e.season?.slug ?? '')
      || !/^\d+$/.test(e.id ?? '') || !Number.isFinite(kickoffAt) || now>=kickoffAt || kickoffAt-now>24*3600000) return [];
    const home=c.competitors?.find(t=>t.homeAway==='home'),away=c.competitors?.find(t=>t.homeAway==='away');
    if (!home || !away || c.competitors?.length!==2 || !/^[A-Z]{2,3}$/.test(home.team?.abbreviation ?? '') || !/^[A-Z]{2,3}$/.test(away.team?.abbreviation ?? '')) return [];
    const spread=c.odds?.find(o=>typeof o.spread==='number' && Number.isFinite(o.spread) && Math.abs(o.spread)<=40)?.spread;
    if (spread===undefined) return [];
    return [{gameId:e.id!,homeTeam:home.team!.abbreviation!,awayTeam:away.team!.abbreviation!,spread,capturedAt:now,kickoffAt,source:'espn-pregame-spread' as const}];
  });
}
