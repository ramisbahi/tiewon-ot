'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { forecast, modelSummary } from '@/lib/model';
import { ESPN_SCOREBOARD_URL, parseScoreboard } from '@/lib/espn';
import type { GameState, Possession } from '@/lib/types';

const KICKOFF_RATE = modelSummary.overtimeGames / modelSummary.games;

const BASE_DEMO: GameState = {
  id: 'demo-two-minute', awayTeam: 'MIN', homeTeam: 'GB', awayScore: 24, homeScore: 24,
  quarter: 4, clockSeconds: 112, clockLabel: '1:52', possession: 'away', down: 1,
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
];

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
          <div className="possession-line">{possessionTeam(state)} ball · {state.down}{state.down === 1 ? 'st' : state.down === 2 ? 'nd' : state.down === 3 ? 'rd' : 'th'} &amp; {state.distance} · own {state.yardlineOwn}</div>
          {event && <div className="event-line">{event}</div>}
        </div>
        <div className={`probability-block ${band}`}>
          <span className="probability-label">Tied at 0:00</span>
          <strong className="probability-value">{percent(prediction.regulationTie)}</strong>
          <span className="probability-caption">Chance regulation ends level</span>
        </div>
        <div className="signal-panel">
          <div><span>Final draw</span><strong>{percent(prediction.finalDraw)}</strong></div>
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
  useEffect(() => { loadGames(); const timer = window.setInterval(loadGames, 15_000); return () => window.clearInterval(timer); }, [loadGames]);
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
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setPlayIndex((index) => {
      const next = index + 1;
      if (next >= PLAYBACK.length) { setPlaying(false); return index; }
      setState(PLAYBACK[next].state); return next;
    }), 1800);
    return () => window.clearInterval(timer);
  }, [playing]);
  const update = <K extends keyof GameState>(key: K, value: GameState[K]) => {
    setPlaying(false);
    setState((current) => ({ ...current, [key]: value, ...(key === 'clockSeconds' ? { clockLabel: clockLabel(Number(value)) } : {}) }));
  };
  const prediction = useMemo(() => forecast(state), [state]);
  const offenseDiff = state.possession === 'home' ? state.homeScore - state.awayScore : state.awayScore - state.homeScore;
  const context = offenseDiff === 0 ? 'Tie game' : offenseDiff > 0 ? `Possessing team leads by ${offenseDiff}` : `Possessing team trails by ${Math.abs(offenseDiff)}`;
  function choosePreset(index: number) { setActivePreset(index); setState(PRESETS[index].state); setPlaying(false); setPlayIndex(0); }
  function startPlayback() { setActivePreset(0); setPlayIndex(0); setState(PLAYBACK[0].state); setPlaying(true); }
  return (
    <section className="simulator-section">
      <div className="simulator-intro"><div><p className="section-kicker">Scenario lab</p><h2>Build any game state.<br />See the forecast instantly.</h2></div><p>Use a preset, edit every input, or play a complete two-minute drill. The exact same model scores live and simulated games.</p></div>
      <div className="preset-grid">{PRESETS.map((preset, index) => <button key={preset.label} className={`preset-card ${activePreset === index ? 'active' : ''}`} type="button" onClick={() => choosePreset(index)}><span>0{index + 1}</span><strong>{preset.label}</strong><small>{preset.description}</small></button>)}</div>
      <div className="simulator-workbench">
        <div className="control-panel">
          <div className="control-panel-heading"><div><p className="section-kicker">Inputs</p><h3>{context}</h3></div><button className="secondary-button" type="button" onClick={startPlayback}>{playing ? 'Playing…' : 'Play drive'}</button></div>
          <div className="score-controls">
            <label><span>Away</span><input aria-label="Away team abbreviation" maxLength={3} value={state.awayTeam} onChange={(event) => update('awayTeam', event.target.value.toUpperCase())} /></label>
            <label className="score-input"><span>Score</span><input aria-label="Away score" type="number" min="0" max="70" value={state.awayScore} onChange={(event) => update('awayScore', Number(event.target.value))} /></label><span className="score-divider">—</span>
            <label className="score-input"><span>Score</span><input aria-label="Home score" type="number" min="0" max="70" value={state.homeScore} onChange={(event) => update('homeScore', Number(event.target.value))} /></label>
            <label><span>Home</span><input aria-label="Home team abbreviation" maxLength={3} value={state.homeTeam} onChange={(event) => update('homeTeam', event.target.value.toUpperCase())} /></label>
          </div>
          <div className="segmented-field"><span>Possession</span><div>{(['away', 'home'] as Possession[]).map((side) => <button className={state.possession === side ? 'active' : ''} key={side} type="button" onClick={() => update('possession', side)}>{side === 'away' ? state.awayTeam : state.homeTeam}</button>)}</div></div>
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
          <p className="section-kicker">Model output</p><span className="forecast-label">Tied at 0:00</span><strong className="forecast-value">{percent(prediction.regulationTie)}</strong><div className="forecast-meter"><span style={{ width: `${Math.max(1, prediction.regulationTie * 100)}%` }} /></div>
          <div className="forecast-stats"><div><span>Final draw</span><strong>{percent(prediction.finalDraw)}</strong></div><div><span>Kickoff baseline</span><strong>{percent(KICKOFF_RATE)}</strong></div><div><span>Relative likelihood</span><strong>{(prediction.regulationTie / KICKOFF_RATE).toFixed(1)}×</strong></div></div>
          <p className="forecast-note">“Tied at 0:00” is the probability of reaching overtime. “Final draw” estimates the rarer chance the regular-season overtime period also ends tied.</p>
          {playing || playIndex > 0 ? <div className="playback-event"><span>Drive event {playIndex + 1}/{PLAYBACK.length}</span><strong>{PLAYBACK[playIndex].event}</strong></div> : null}
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
