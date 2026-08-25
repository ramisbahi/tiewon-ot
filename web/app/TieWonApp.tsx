'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { forecast, modelSummary } from '@/lib/model';
import { predictRegulationOutcomes } from '@/lib/outcome-model';
import { simulateTieProbabilityAsync, simulationSummary, type SimulationResult } from '@/lib/monte-carlo';
import { simulateNextPlay } from '@/lib/simulator';
import { ESPN_SCOREBOARD_URL, parseScoreboard } from '@/lib/espn';
import type { GamePhase, GameState, OvertimeRules, Possession, TryType } from '@/lib/types';

const KICKOFF_RATE = modelSummary.overtimeGames / modelSummary.games;

const BASE_DEMO: GameState = {
  id: 'demo-two-minute', awayTeam: 'MIN', homeTeam: 'GB', awayScore: 24, homeScore: 24,
  quarter: 4, clockSeconds: 112, clockLabel: '1:52', possession: 'away', down: 1,
  phase: 'scrimmage', tryType: 'kick', pendingTryTeam: 'away',
  overtimeRules: 'current_regular',
  distance: 10, yardlineOwn: 25, timeoutsHome: 2, timeoutsAway: 2, status: 'DEMO',
  detail: 'Scenario playback', isLive: false, seasonType: 'regular', source: 'demo',
};

const PLAYBACK: Array<{ event: string; state: GameState }> = [
  { event: 'Drive starts after a touchback', state: BASE_DEMO },
  { event: 'Completion for 14 yards', state: { ...BASE_DEMO, clockSeconds: 91, clockLabel: '1:31', down: 1, distance: 10, yardlineOwn: 39 } },
  { event: 'Run stopped for two', state: { ...BASE_DEMO, clockSeconds: 66, clockLabel: '1:06', down: 2, distance: 8, yardlineOwn: 41, timeoutsHome: 1 } },
  { event: 'Pass complete across midfield', state: { ...BASE_DEMO, clockSeconds: 43, clockLabel: '0:43', down: 1, distance: 10, yardlineOwn: 58, timeoutsHome: 1 } },
  { event: 'Six-yard gain; timeout', state: { ...BASE_DEMO, clockSeconds: 31, clockLabel: '0:31', down: 2, distance: 4, yardlineOwn: 64, timeoutsAway: 1, timeoutsHome: 1 } },
  { event: 'Field-goal range, clock running', state: { ...BASE_DEMO, clockSeconds: 15, clockLabel: '0:15', down: 3, distance: 2, yardlineOwn: 70, timeoutsAway: 1, timeoutsHome: 1 } },
];

const PRESETS: Array<{ label: string; description: string; state: GameState }> = [
  { label: 'Tied, two-minute drill', description: 'Tie game, full field ahead', state: BASE_DEMO },
  { label: 'Down three, in range', description: 'One kick can force overtime', state: { ...BASE_DEMO, id: 'preset-down-three', awayScore: 21, homeScore: 24, clockSeconds: 48, clockLabel: '0:48', down: 2, distance: 7, yardlineOwn: 66, timeoutsAway: 1 } },
  { label: 'Down seven, last drive', description: 'Touchdown and conversion needed', state: { ...BASE_DEMO, id: 'preset-down-seven', awayTeam: 'BUF', homeTeam: 'KC', awayScore: 20, homeScore: 27, clockSeconds: 78, clockLabel: '1:18', down: 1, distance: 10, yardlineOwn: 31, timeoutsAway: 2 } },
  { label: 'Midgame dead heat', description: 'Baseline, lots of football left', state: { ...BASE_DEMO, id: 'preset-midgame', awayTeam: 'DAL', homeTeam: 'PHI', awayScore: 10, homeScore: 10, quarter: 2, clockSeconds: 420, clockLabel: '7:00', possession: 'home', down: 1, distance: 10, yardlineOwn: 25, timeoutsAway: 3, timeoutsHome: 3 } },
  { label: 'Custom', description: 'Start here, then edit every field', state: { ...BASE_DEMO, id: 'custom', awayTeam: 'AWY', homeTeam: 'HME', awayScore: 17, homeScore: 20, clockSeconds: 180, clockLabel: '3:00' } },
];
const CUSTOM_PRESET = PRESETS.length - 1;

function percent(value: number, digits = 1) {
  if (value > 0 && value < 0.001) return '<0.1%';
  return `${(value * 100).toFixed(digits)}%`;
}
function clockLabel(seconds: number) { return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
function quarterLabel(quarter: number) { return quarter > 4 ? 'OT' : `Q${quarter}`; }
function possessionTeam(state: GameState) { return state.possession === 'home' ? state.homeTeam : state.awayTeam; }
function probabilityBand(value: number) { return value >= 0.4 ? 'hot' : value >= 0.16 ? 'warm' : 'cool'; }

function GameCard({ state, event, compact = false }: { state: GameState; event?: string; compact?: boolean }) {
  const prediction = forecast(state);
  const band = probabilityBand(prediction.regulationTie);
  const ballLeft = Math.min(97, Math.max(3, state.yardlineOwn));
  const kickoffMultiple = prediction.regulationTie / KICKOFF_RATE;
  return (
    <article className={`game-card ${compact ? 'compact-card' : ''}`}>
      <div className="game-topline">
        <span className={state.isLive ? 'live-pill' : 'demo-pill'}><span className={state.isLive ? 'pulse-dot' : ''} />{state.isLive ? 'Live' : 'Scenario playback'}</span>
        <span>{quarterLabel(state.quarter)} · {state.clockLabel}</span>
      </div>
      <div className="game-grid">
        <div className="matchup">
          <div className={`team-row ${state.possession === 'away' ? 'has-ball' : ''}`}><span className="team-code">{state.awayTeam}</span><strong>{state.awayScore}</strong></div>
          <div className={`team-row ${state.possession === 'home' ? 'has-ball' : ''}`}><span className="team-code">{state.homeTeam}</span><strong>{state.homeScore}</strong></div>
          <div className="possession-line">{state.phase === 'pending_try'
            ? `${state.pendingTryTeam === 'home' ? state.homeTeam : state.awayTeam} · ${state.tryType === 'kick' ? 'extra point' : 'two-point try'} pending`
            : `${possessionTeam(state)} ball · ${state.down}${state.down === 1 ? 'st' : state.down === 2 ? 'nd' : state.down === 3 ? 'rd' : 'th'} & ${state.distance} · own ${state.yardlineOwn}`}</div>
          {event && <div className="event-line">{event}</div>}
        </div>
        <div className={`probability-block ${band}`}>
          <span className="probability-label">Tied at 0:00</span>
          <strong className="probability-value">{percent(prediction.regulationTie)}</strong>
          <span className="probability-caption">Chance regulation ends level</span>
        </div>
        <div className="signal-panel">
          <div><span>OT format</span><strong>{state.overtimeRules === 'current_regular' ? '2025+' : state.overtimeRules === 'legacy_regular' ? 'Legacy' : 'Playoffs'}</strong></div>
          <div><span>Vs. kickoff</span><strong>{kickoffMultiple.toFixed(1)}×</strong></div>
          <div><span>Feed</span><strong>{state.isLive ? 'Live' : 'Demo'}</strong></div>
        </div>
      </div>
      <div className="field-strip" aria-label={`Ball on the ${possessionTeam(state)} ${state.yardlineOwn} yard line`}>
        <span className="endzone">OWN</span><span>20</span><span>40</span><span className="ball" style={{ left: `${ballLeft}%` }} /><span className="midfield">50</span><span>40</span><span>20</span><span className="endzone">OPP</span>
      </div>
    </article>
  );
}

function LiveBoard({ onOpenSimulator }: { onOpenSimulator: () => void }) {
  const [games, setGames] = useState<GameState[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedError, setFeedError] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [demoIndex, setDemoIndex] = useState(0);
  const [demoPlaying, setDemoPlaying] = useState(true);
  const loadGames = useCallback(async () => {
    try {
      const response = await fetch(ESPN_SCOREBOARD_URL, { cache: 'no-store' });
      if (!response.ok) throw new Error('feed');
      const payload = await response.json();
      setGames(parseScoreboard(payload)); setLastUpdated(new Date()); setFeedError(false);
    } catch { setFeedError(true); } finally { setLoading(false); }
  }, []);
  useEffect(() => { const initial = window.setTimeout(loadGames, 0); const timer = window.setInterval(loadGames, 15_000); return () => { window.clearTimeout(initial); window.clearInterval(timer); }; }, [loadGames]);
  useEffect(() => {
    if (!demoPlaying || games.length) return;
    const timer = window.setInterval(() => setDemoIndex((index) => (index + 1) % PLAYBACK.length), 2600);
    return () => window.clearInterval(timer);
  }, [demoPlaying, games.length]);
  const demo = PLAYBACK[demoIndex];
  const statusCopy = loading ? 'Checking the live board…' : games.length ? `${games.length} game${games.length === 1 ? '' : 's'} live · refreshes every 15 seconds` : 'No NFL games are live · demo mode is active';
  return (
    <>
      <section className="feed-status" aria-live="polite">
        <div><span className={games.length ? 'live-dot' : 'idle-dot'} />{statusCopy}</div>
        <div className="feed-actions">{feedError && <span className="feed-warning">Live feed unavailable</span>}{lastUpdated && <span>Updated {lastUpdated.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</span>}<button className="text-button" type="button" onClick={loadGames}>Refresh now</button></div>
      </section>
      <section className="board-heading"><div><p className="section-kicker">{games.length ? 'Live board' : 'Demo feed'}</p><h2>{games.length ? 'Games in progress.' : 'The lab stays open between kickoffs.'}</h2></div><button className="primary-button" type="button" onClick={onOpenSimulator}>Open simulator</button></section>
      <div className="game-list">
        {games.length ? games.map((game) => <GameCard key={game.id} state={game} />) : <><GameCard state={demo.state} event={demo.event} /><div className="demo-controls"><button className="secondary-button" type="button" onClick={() => setDemoPlaying((playing) => !playing)}>{demoPlaying ? 'Pause playback' : 'Resume playback'}</button><div className="playback-steps" aria-label={`Step ${demoIndex + 1} of ${PLAYBACK.length}`}>{PLAYBACK.map((_, index) => <button key={index} aria-label={`Go to demo step ${index + 1}`} className={index === demoIndex ? 'active' : ''} type="button" onClick={() => { setDemoIndex(index); setDemoPlaying(false); }} />)}</div><button className="text-button" type="button" onClick={onOpenSimulator}>Edit this state →</button></div></>}
      </div>
      <section className="method-strip"><div><strong>{modelSummary.games.toLocaleString()}</strong><span>games trained</span></div><div><strong>{modelSummary.snapshots.toLocaleString()}</strong><span>play states</span></div><div><strong>0.885</strong><span>late-game AUC</span></div><p>One calibrated model replaces the old Monte Carlo, R bridges, random fallback, and sportsbook scraper.</p></section>
    </>
  );
}

function RangeField({ label, value, min, max, step = 1, display, onChange }: { label: string; value: number; min: number; max: number; step?: number; display?: string; onChange: (value: number) => void }) {
  return <label className="range-field"><span><span>{label}</span><strong>{display ?? value}</strong></span><input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function Simulator() {
  const [state, setState] = useState<GameState>(BASE_DEMO);
  const [activePreset, setActivePreset] = useState(0);
  const [playIndex, setPlayIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [lastEvent, setLastEvent] = useState('Ready at the selected game state');
  const [simulation, setSimulation] = useState<SimulationResult | null>(null);
  const [simulationProgress, setSimulationProgress] = useState(0);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setState((current) => {
        const result = simulateNextPlay(current, playIndex + 1);
        setLastEvent(result.event);
        setPlayIndex((index) => index + 1);
        if ((result.state.quarter === 4 && result.state.clockSeconds === 0) || playIndex >= 11) setPlaying(false);
        return result.state;
      });
    }, 1350);
    return () => window.clearInterval(timer);
  }, [playing, playIndex]);
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setSimulation(null);
      setSimulationProgress(0);
      const result = await simulateTieProbabilityAsync(
        state, 10_000, (progress) => { if (!cancelled) setSimulationProgress(progress); }, () => cancelled,
      );
      if (!cancelled && result) setSimulation(result);
    }, 120);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [state]);
  const update = <K extends keyof GameState>(key: K, value: GameState[K]) => {
    setPlaying(false);
    setActivePreset(CUSTOM_PRESET);
    setPlayIndex(0);
    setLastEvent('Custom state updated');
    setState((current) => ({ ...current, [key]: value, ...(key === 'clockSeconds' ? { clockLabel: clockLabel(Number(value)) } : {}) }));
  };
  const prediction = useMemo(() => forecast(state), [state]);
  const historicalOutcomes = useMemo(() => predictRegulationOutcomes(state), [state]);
  const offenseDiff = state.possession === 'home' ? state.homeScore - state.awayScore : state.awayScore - state.homeScore;
  const context = state.phase === 'pending_try'
    ? `${state.pendingTryTeam === 'home' ? state.homeTeam : state.awayTeam} conversion pending`
    : offenseDiff === 0 ? 'Tie game' : offenseDiff > 0 ? `Possessing team leads by ${offenseDiff}` : `Possessing team trails by ${Math.abs(offenseDiff)}`;
  const disagreement = simulation ? Math.abs(simulation.estimate - prediction.regulationTie) : 0;
  function choosePreset(index: number) { setActivePreset(index); setState({ ...PRESETS[index].state }); setPlaying(false); setPlayIndex(0); setLastEvent(`Loaded: ${PRESETS[index].label}`); }
  function startPlayback() { setPlaying((current) => !current); }
  return (
    <section className="simulator-section">
      <div className="simulator-intro"><div><p className="section-kicker">Scenario lab</p><h2>Build any game state.<br />Check it two ways.</h2></div><p>The calibrated model answers instantly. An independent Monte Carlo engine then samples 10,000 futures from empirical drive outcomes as a visible sanity check.</p></div>
      <div className="preset-grid">{PRESETS.map((preset, index) => <button key={preset.label} className={`preset-card ${activePreset === index ? 'active' : ''}`} type="button" onClick={() => choosePreset(index)}><span>0{index + 1}</span><strong>{preset.label}</strong><small>{preset.description}</small></button>)}</div>
      <div className="simulator-workbench">
        <div className="control-panel">
          <div className="control-panel-heading"><div><p className="section-kicker">Inputs</p><h3>{context}</h3></div><button className="secondary-button" type="button" onClick={startPlayback}>{playing ? 'Pause scenario' : 'Play scenario'}</button></div>
          <div className="score-controls">
            <label><span>Away</span><input aria-label="Away team abbreviation" maxLength={3} value={state.awayTeam} onChange={(event) => update('awayTeam', event.target.value.toUpperCase())} /></label>
            <label className="score-input"><span>Score</span><input aria-label="Away score" type="number" min="0" max="70" value={state.awayScore} onChange={(event) => update('awayScore', Number(event.target.value))} /></label><span className="score-divider">—</span>
            <label className="score-input"><span>Score</span><input aria-label="Home score" type="number" min="0" max="70" value={state.homeScore} onChange={(event) => update('homeScore', Number(event.target.value))} /></label>
            <label><span>Home</span><input aria-label="Home team abbreviation" maxLength={3} value={state.homeTeam} onChange={(event) => update('homeTeam', event.target.value.toUpperCase())} /></label>
          </div>
          <div className="segmented-field"><span>Play state</span><div>{([['scrimmage', 'Normal snap'], ['pending_try', 'Pending try']] as [GamePhase, string][]).map(([phase, label]) => <button className={state.phase === phase ? 'active' : ''} key={phase} type="button" onClick={() => update('phase', phase)}>{label}</button>)}</div></div>
          <div className="segmented-field"><span>Possession</span><div>{(['away', 'home'] as Possession[]).map((side) => <button className={state.possession === side ? 'active' : ''} key={side} type="button" onClick={() => update('possession', side)}>{side === 'away' ? state.awayTeam : state.homeTeam}</button>)}</div></div>
          {state.phase === 'pending_try' && <>
            <div className="segmented-field"><span>Try belongs to</span><div>{(['away', 'home'] as Possession[]).map((side) => <button className={state.pendingTryTeam === side ? 'active' : ''} key={side} type="button" onClick={() => { update('pendingTryTeam', side); setState((current) => ({ ...current, possession: side })); }}>{side === 'away' ? state.awayTeam : state.homeTeam}</button>)}</div></div>
            <div className="segmented-field"><span>Conversion</span><div>{([['kick', 'Extra point'], ['two_point', 'Two points']] as [TryType, string][]).map(([tryType, label]) => <button className={state.tryType === tryType ? 'active' : ''} key={tryType} type="button" onClick={() => update('tryType', tryType)}>{label}</button>)}</div></div>
          </>}
          <div className="segmented-field"><span>Overtime rules</span><div>{([['current_regular', '2025+ regular'], ['legacy_regular', 'Through 2024'], ['postseason', 'Postseason']] as [OvertimeRules, string][]).map(([rules, label]) => <button className={state.overtimeRules === rules ? 'active' : ''} key={rules} type="button" onClick={() => { update('overtimeRules', rules); if (rules === 'postseason') setState((current) => ({ ...current, seasonType: 'postseason' })); else setState((current) => ({ ...current, seasonType: 'regular' })); }}>{label}</button>)}</div></div>
          <div className="two-column-controls">
            <RangeField label="Quarter" min={1} max={4} value={state.quarter} display={`Q${state.quarter}`} onChange={(value) => update('quarter', value)} />
            <RangeField label="Quarter clock" min={0} max={900} step={5} value={state.clockSeconds} display={clockLabel(state.clockSeconds)} onChange={(value) => update('clockSeconds', value)} />
            <RangeField label="Down" min={1} max={4} value={state.down} onChange={(value) => update('down', value)} />
            <RangeField label="Yards to go" min={1} max={20} value={state.distance} onChange={(value) => update('distance', value)} />
            <RangeField label="Own yard line" min={1} max={99} value={state.yardlineOwn} onChange={(value) => update('yardlineOwn', value)} />
            <RangeField label={`${state.awayTeam} timeouts`} min={0} max={3} value={state.timeoutsAway} onChange={(value) => update('timeoutsAway', value)} />
            <RangeField label={`${state.homeTeam} timeouts`} min={0} max={3} value={state.timeoutsHome} onChange={(value) => update('timeoutsHome', value)} />
          </div>
        </div>
        <aside className={`forecast-panel ${probabilityBand(prediction.regulationTie)}`} aria-live="polite">
          <p className="section-kicker">Two-estimate check</p><span className="forecast-label">Historical model · tied at 0:00</span><strong className="forecast-value">{percent(prediction.regulationTie)}</strong><div className="forecast-meter"><span style={{ width: `${Math.max(1, prediction.regulationTie * 100)}%` }} /></div>
          <div className="estimate-comparison"><div><span>Monte Carlo · 10,000 futures</span><strong>{simulation ? percent(simulation.estimate) : `Running ${Math.round(simulationProgress * 100)}%`}</strong></div>{simulation && <small>95% interval {percent(simulation.lower)}–{percent(simulation.upper)}</small>}{simulation && disagreement >= 0.05 && <em>Estimates differ by {percent(disagreement)} — treat this state with extra caution.</em>}</div>
          <div className="outcome-panel"><span>Historical model · regulation</span><div className="outcome-bar"><i style={{ width: `${historicalOutcomes.awayAhead * 100}%` }} /><i style={{ width: `${historicalOutcomes.tied * 100}%` }} /><i style={{ width: `${historicalOutcomes.homeAhead * 100}%` }} /></div><div className="outcome-grid"><div><small>{state.awayTeam} ahead</small><strong>{percent(historicalOutcomes.awayAhead)}</strong></div><div><small>Tied</small><strong>{percent(historicalOutcomes.tied)}</strong></div><div><small>{state.homeTeam} ahead</small><strong>{percent(historicalOutcomes.homeAhead)}</strong></div></div></div>
          {simulation && <div className="outcome-panel"><span>Monte Carlo regulation outcome</span><div className="outcome-bar" aria-label={`${state.awayTeam} ahead ${percent(simulation.awayAhead)}, tied ${percent(simulation.estimate)}, ${state.homeTeam} ahead ${percent(simulation.homeAhead)}`}><i style={{ width: `${simulation.awayAhead * 100}%` }} /><i style={{ width: `${simulation.estimate * 100}%` }} /><i style={{ width: `${simulation.homeAhead * 100}%` }} /></div><div className="outcome-grid"><div><small>{state.awayTeam} ahead</small><strong>{percent(simulation.awayAhead)}</strong></div><div><small>Tied</small><strong>{percent(simulation.estimate)}</strong></div><div><small>{state.homeTeam} ahead</small><strong>{percent(simulation.homeAhead)}</strong></div></div></div>}
          {simulation && <div className="outcome-panel final-outcome"><span>Monte Carlo final result · {state.overtimeRules === 'current_regular' ? '2025+ OT' : state.overtimeRules === 'legacy_regular' ? 'legacy OT' : 'postseason OT'}</span><div className="outcome-bar"><i style={{ width: `${simulation.awayWin * 100}%` }} /><i style={{ width: `${simulation.finalDraw * 100}%` }} /><i style={{ width: `${simulation.homeWin * 100}%` }} /></div><div className="outcome-grid"><div><small>{state.awayTeam} win</small><strong>{percent(simulation.awayWin)}</strong></div><div><small>Final tie</small><strong>{percent(simulation.finalDraw)}</strong></div><div><small>{state.homeTeam} win</small><strong>{percent(simulation.homeWin)}</strong></div></div></div>}
          <div className="forecast-stats"><div><span>Rule-aware final draw</span><strong>{simulation ? percent(simulation.finalDraw) : 'Running'}</strong></div><div><span>Kickoff tie baseline</span><strong>{percent(KICKOFF_RATE)}</strong></div><div><span>Relative tie likelihood</span><strong>{(prediction.regulationTie / KICKOFF_RATE).toFixed(1)}×</strong></div></div>
          <p className="forecast-note">The historical model is the primary estimate. The simulation independently resamples drive outcomes fitted to {simulationSummary.drives.toLocaleString()} drives; its interval reflects Monte Carlo sampling error, not every source of model uncertainty.</p>
          <div className="playback-event"><span>Scenario event {playIndex}</span><strong>{lastEvent}</strong></div>
        </aside>
      </div>
    </section>
  );
}

export default function TieWonApp() {
  const [view, setView] = useState<'live' | 'simulator'>('live');
  return (
    <main className="shell" id="top">
      <header className="topbar"><button className="brand brand-button" type="button" onClick={() => setView('live')} aria-label="TieWon home"><span className="brand-mark">TW</span><span>TieWon</span></button><nav className="view-switch" aria-label="Dashboard views"><button className={`view-button ${view === 'live' ? 'active' : ''}`} type="button" onClick={() => setView('live')}>Live board</button><button className={`view-button ${view === 'simulator' ? 'active' : ''}`} type="button" onClick={() => setView('simulator')}>Simulator</button></nav><div className="model-stamp"><span className="live-dot" /> Model v{modelSummary.version.split('.')[0]}</div></header>
      <section className="hero"><div><p className="eyebrow">Live NFL tie forecast</p><h1>Every snap changes<br />the shape of overtime.</h1></div><p className="hero-copy">A calibrated play-state model trained on five seasons of NFL data. Live on game day, fully explorable whenever the league is quiet.</p></section>
      {view === 'live' ? <LiveBoard onOpenSimulator={() => setView('simulator')} /> : <Simulator />}
      <footer className="footer-note"><span>Empirical model · 2021–2025 play-by-play · game-grouped validation</span><span>For information and entertainment; not betting advice.</span></footer>
    </main>
  );
}
