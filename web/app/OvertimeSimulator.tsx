'use client';
import { useEffect, useState } from 'react';
import type { GameState, Possession, OvertimeRules } from '@/lib/types';
import { overtimeScenario, type OTStage } from '@/lib/ot-scenario';
import { FRESH_OT_TIE_RATE } from '@/lib/ot-model';
const pct = (p: number) => `${(p * 100).toFixed(1)}%`;
const clock = (n: number) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
function initial(base: GameState): GameState {
  return { ...base, id: 'ot-scenario', quarter: 5, homeScore: Math.max(base.homeScore, base.awayScore), awayScore: Math.max(base.homeScore, base.awayScore),
    clockSeconds: 600, clockLabel: '10:00', phase: 'scrimmage', down: 1, distance: 10, yardlineOwn: 30, timeoutsHome: 2, timeoutsAway: 2 };
}
export default function OvertimeSimulator({ base }: { base: GameState }) {
  const [state, setState] = useState(() => initial(base));
  const [stage, setStage] = useState<OTStage>('opening');
  const [result, setResult] = useState<ReturnType<typeof overtimeScenario> | null>(null);
  useEffect(() => { setResult(null); const timer = window.setTimeout(() => setResult(overtimeScenario(state, stage)), 100); return () => window.clearTimeout(timer); }, [state, stage]);
  const update = <K extends keyof GameState>(key: K, value: GameState[K]) => setState(s => ({ ...s, [key]: value }));
  const chooseStage = (next: OTStage) => {
    setStage(next);
    setState(s => { const score = Math.min(s.homeScore, s.awayScore); return { ...s, homeScore: score + (next === 'response' && s.possession === 'away' ? 3 : 0),
      awayScore: score + (next === 'response' && s.possession === 'home' ? 3 : 0), clockSeconds: next === 'opening' ? 600 : next === 'response' ? 300 : 120,
      down: 1, distance: 10, yardlineOwn: 30 }; });
  };
  return <section className="simulator-section">
    <div className="simulator-intro"><div><p className="section-kicker">Overtime lab</p><h2>Can they both<br />leave without a win?</h2></div><p>Start at any point in OT. The score, remaining clock, field position and each team's possession opportunity all change the chance of a final tie.</p></div>
    <div className="simulator-workbench"><div className="control-panel">
      <div className="control-panel-heading"><h3>Overtime state</h3><button className="secondary-button" onClick={() => { setState(initial(base)); setStage('opening'); }}>Reset OT</button></div>
      <div className="score-controls">
        <label><span>Away</span><input aria-label="OT away team" maxLength={3} value={state.awayTeam} onChange={e => update('awayTeam', e.target.value.toUpperCase())}/></label><label className="score-input"><span>Score</span><input aria-label="OT away score" type="number" min={0} max={200} value={state.awayScore} onChange={e => update('awayScore', Number(e.target.value))}/></label><span className="score-divider">—</span><label className="score-input"><span>Score</span><input aria-label="OT home score" type="number" min={0} max={200} value={state.homeScore} onChange={e => update('homeScore', Number(e.target.value))}/></label><label><span>Home</span><input aria-label="OT home team" maxLength={3} value={state.homeTeam} onChange={e => update('homeTeam', e.target.value.toUpperCase())}/></label>
      </div>
      <div className="segmented-field"><span>Possession stage</span><div>{([['opening','Opening possession'],['response','Other team responds'],['sudden_death','Sudden death']] as [OTStage,string][]).map(([value,label]) => <button key={value} className={stage===value?'active':''} onClick={() => chooseStage(value)}>{label}</button>)}</div></div>
      <p className="history-note">{stage === 'opening' ? 'Neither team has completed its first possession.' : stage === 'response' ? 'The opponent has completed one possession. The team with the ball has not.' : 'Both teams have had the ball. The next score wins.'} Scores include completed extra points. Set up the next normal snap.</p>
      <div className="segmented-field"><span>Team with the ball</span><div>{(['away','home'] as Possession[]).map(side => <button key={side} className={state.possession===side?'active':''} onClick={() => update('possession',side)}>{side==='away'?state.awayTeam:state.homeTeam}</button>)}</div></div>
      <div className="segmented-field"><span>Overtime rules</span><div>{([['current_regular','2025+ regular'],['legacy_regular','Through 2024'],['postseason','Postseason']] as [OvertimeRules,string][]).map(([value,label]) => <button key={value} className={state.overtimeRules===value?'active':''} onClick={() => setState(s => ({...s,overtimeRules:value,seasonType:value==='postseason'?'postseason':'regular',clockSeconds:Math.min(s.clockSeconds,value==='postseason'?900:600)}))}>{label}</button>)}</div></div>
      <div className="two-column-controls">{[
        {key:'clockSeconds',label:'OT clock',min:1,max:state.overtimeRules==='postseason'?900:600,display:clock(state.clockSeconds)},
        {key:'down',label:'Down',min:1,max:4}, {key:'distance',label:'Yards to go',min:1,max:30}, {key:'yardlineOwn',label:'Own yard line',min:1,max:99},
        {key:'timeoutsAway',label:`${state.awayTeam} timeouts`,min:0,max:2}, {key:'timeoutsHome',label:`${state.homeTeam} timeouts`,min:0,max:2},
      ].map(field => <label className="range-field" key={field.key}><span><span>{field.label}</span><strong>{field.display ?? state[field.key as keyof GameState]}</strong></span><input type="range" aria-label={field.label} min={field.min} max={field.max} value={state[field.key as keyof GameState] as number} onChange={e => update(field.key as keyof GameState,Number(e.target.value))}/></label>)}</div>
    </div><aside className="forecast-panel" aria-live="polite"><p className="section-kicker">OT forecast</p><span className="forecast-label">Chance of a final tie</span><strong className="forecast-value">{result ? result.finalTie == null ? '—' : pct(result.finalTie) : '…'}</strong>
      {result?.error && <p role="status">{result.error}</p>}
      <div className="forecast-stats"><div><span>Chance of overtime</span><strong>100%</strong></div><div><span>Fresh OT · new rules baseline</span><strong>{pct(FRESH_OT_TIE_RATE)}</strong></div></div>
      <p className="forecast-note">{state.overtimeRules === 'postseason' ? 'Playoff games continue until a winner is decided. A final tie is impossible.' : '10,000 simulated futures from this OT state. New-rule estimates are anchored to 2025 regular-season OT results: 1 tie in 14 games, smoothed to 10%. The sample is small; live-state adjustments remain approximate.'}</p>
      <p className="forecast-note">A touchdown responding to an opening touchdown assumes a 90% chance of going for two. Conversion success is sampled separately. Scoreless drives and matching field goals can leave the game tied as time runs out.</p>
    </aside></div>
  </section>;
}
