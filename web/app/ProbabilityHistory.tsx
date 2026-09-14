'use client';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { Snapshot } from '@/lib/history';

const pct = (p: number | null | undefined) => p == null ? 'Unavailable' : `${(p * 100).toFixed(1)}%`;
export default function ProbabilityHistory({ gameId, live }: { gameId: string; live: boolean }) {
  const instructionsId = useId();
  const activePointer = useRef<number | null>(null);
  const [samples, setSamples] = useState<Snapshot[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    activePointer.current = null;
    setSamples([]); setSelected(null); setLoading(true);
    let busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const response = await fetch(`/api/history?game=${encodeURIComponent(gameId)}`, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('history');
        const payload = await response.json() as { snapshots: Snapshot[] };
        if (!controller.signal.aborted) { const replay = payload.snapshots.filter(s => s.origin === 'reconstructed'); setSamples(replay.length ? replay.sort((a,b) => Number(a.playId) - Number(b.playId)) : payload.snapshots); setError(false); }
      } catch { if (!controller.signal.aborted) setError(true); }
      finally { if (!controller.signal.aborted) setLoading(false); busy = false; }
    };
    void load();
    const timer = live ? window.setInterval(load, 15000) : undefined;
    return () => { controller.abort(); if (timer) window.clearInterval(timer); };
  }, [gameId, live]);
  if (loading) return <div className="history-panel">Loading saved probabilities...</div>;
  if (error) return <div className="history-panel" role="status">Saved history is temporarily unavailable. <button className="text-button" onClick={() => window.location.reload()}>Retry</button></div>;
  if (!samples.length) return <div className="history-panel">No recorded probabilities yet. History begins when this game is first tracked.</div>;
  const index = selected == null ? samples.length - 1 : Math.min(selected, samples.length - 1);
  const point = samples[index];
  const reconstructed = samples.some(s => s.origin === 'reconstructed');
  const firstTime = samples[0].observedAt;
  const span = Math.max(15000, samples.at(-1)!.observedAt - firstTime);
  const positions = samples.map((s, i) => 50 + (reconstructed ? i / Math.max(1, samples.length - 1) : (s.observedAt - firstTime) / span) * 890);
  const cursorX = positions[index];
  function selectAtPointer(event: PointerEvent<SVGSVGElement>) {
    const chart = event.currentTarget;
    const matrix = chart.getScreenCTM();
    if (!matrix) return;
    // SVG coordinates account for responsive scaling AND viewBox letterboxing.
    const pointer = chart.createSVGPoint();
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    const chartX = pointer.matrixTransform(matrix.inverse()).x;
    let closest = 0;
    for (let i = 1; i < positions.length; i++) {
      if (Math.abs(positions[i] - chartX) < Math.abs(positions[closest] - chartX)) closest = i;
    }
    setSelected(closest);
  }
  function startScrub(event: PointerEvent<SVGSVGElement>) {
    if (!event.isPrimary || event.button !== 0 || activePointer.current !== null) return;
    activePointer.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    selectAtPointer(event);
  }
  function endScrub(event: PointerEvent<SVGSVGElement>) {
    if (event.pointerId !== activePointer.current) return;
    selectAtPointer(event);
    activePointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function keyScrub(event: KeyboardEvent<SVGSVGElement>) {
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? samples.length - 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? index - 1
      : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? index + 1
      : event.key === 'PageDown' ? index - 10 : event.key === 'PageUp' ? index + 10 : null;
    if (next === null) return;
    event.preventDefault();
    setSelected(Math.max(0, Math.min(samples.length - 1, next)));
  }
  const y = (p: number) => 190 - p * 160;
  function paths(key: 'finalTie' | 'overtime') {
    let start = true; let previousTime = 0;
    return samples.map((s, i) => {
      const value = s.probabilities[key];
      if (value === null) { start = true; return ''; }
      const move = start || !reconstructed && s.observedAt - previousTime > 120000;
      start = false; previousTime = s.observedAt;
      return `${move ? 'M' : 'L'}${positions[i].toFixed(1)},${y(value).toFixed(1)}`;
    }).join(' ');
  }
  return <section className="history-panel" aria-label="Recorded game probabilities">
    <div className="history-heading"><strong>How the odds moved</strong><span><i className="legend-final" />Final tie <i className="legend-ot" />Overtime</span></div>
    {reconstructed && <p className="history-note"><strong>Reconstructed from ESPN play-by-play.</strong> These estimates were calculated after the game from each pre-play state, using the model version saved with the archive. The chart follows play order because provider timestamps can be missing or incorrect. They were not recorded or posted live.</p>}
    <svg className="history-chart" viewBox="0 0 960 230"
      role="slider" tabIndex={0} aria-label="Inspect recorded game probabilities"
      aria-orientation="horizontal" aria-valuemin={0} aria-valuemax={samples.length - 1} aria-valuenow={index}
      aria-valuetext={`${point.game.isLive ? point.game.quarter > 4 ? 'OT' : 'Q' + point.game.quarter : 'Final'} ${point.game.clockLabel}, ${point.game.awayTeam} ${point.game.awayScore}, ${point.game.homeTeam} ${point.game.homeScore}, final tie ${pct(point.probabilities.finalTie)}, overtime ${pct(point.probabilities.overtime)}`}
      aria-describedby={instructionsId}
      onPointerDown={startScrub}
      onPointerMove={event => { if (activePointer.current === event.pointerId) selectAtPointer(event); }}
      onPointerUp={endScrub}
      onPointerCancel={() => { activePointer.current = null; }}
      onLostPointerCapture={() => { activePointer.current = null; }}
      onKeyDown={keyScrub}>
      <rect width="960" height="230" fill="transparent" />
      {[0, .2, .5, .75, .9, 1].map(p => <g key={p}><line x1="50" x2="940" y1={y(p)} y2={y(p)} stroke="#d9d7cf" strokeDasharray={p > 0 && p < 1 ? '4 5' : undefined} /><text x="42" y={y(p) + 4} textAnchor="end">{Math.round(p * 100)}%</text></g>)}
      <path d={paths('overtime')} fill="none" stroke="#3158a8" strokeWidth="2.5" strokeDasharray="6 3" />
      <path d={paths('finalTie')} fill="none" stroke="#d63424" strokeWidth="3.5" />
      <line x1={cursorX} x2={cursorX} y1="25" y2="195" stroke="#657081" strokeWidth="1.5" strokeDasharray="3 3" />
      {(['finalTie', 'overtime'] as const).map(key => point.probabilities[key] !== null && <circle key={key} cx={cursorX} cy={y(point.probabilities[key]!)} r="4" fill={key === 'finalTie' ? '#d63424' : '#3158a8'} />)}
      <text x="50" y="219">{reconstructed ? 'Kickoff · play order →' : new Date(firstTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</text>
      <text x="940" y="219" textAnchor="end">{reconstructed ? 'Final' : new Date(samples.at(-1)!.observedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</text>
    </svg>
    <p className="history-scrub-hint" id={instructionsId}>Drag across the graph to explore. Use arrow keys when focused.</p>
    <div className="history-readout"><strong>{point.game.isLive ? point.game.quarter > 4 ? 'OT' : `Q${point.game.quarter}` : 'Final'} {point.game.clockLabel}</strong><span>{point.game.awayTeam} {point.game.awayScore} - {point.game.homeTeam} {point.game.homeScore}</span><span>Final tie <b>{pct(point.probabilities.finalTie)}</b></span><span>OT <b>{pct(point.probabilities.overtime)}</b></span>{live && selected != null && <button className="text-button" onClick={() => setSelected(null)}>Follow latest</button>}</div>
    <p className="history-note">{samples.length} saved snapshots. Gaps mark unavailable estimates or long breaks. {point.origin === 'reconstructed' ? 'Selected point: reconstructed pre-play estimate.' : 'Selected point: recorded live.'} {point.timestampEstimated && 'This timestamp was missing and interpolated.'} Model: {point.modelVersion}. Saved estimates are never recalculated.</p>
  </section>;
}
