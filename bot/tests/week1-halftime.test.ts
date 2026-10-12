import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { reconstructSummary } from '../backfill';
import { backfills } from '../../web/lib/backfills';
import baseline from '../../web/lib/ot-baseline.json';
import { FRESH_OT_TIE_RATE } from '../../web/lib/ot-model';
import { overtimeScenario } from '../../web/lib/ot-scenario';
import { liveProbabilities } from '../../web/lib/live-probabilities';
import { validSnapshot } from '../../web/lib/history';
import { Store } from '../store';
import { publishGames } from '../engine';
import { readConfig } from '../config';
const input = () => JSON.parse(readFileSync(new URL('fixtures/week1-2026/401872923.json', import.meta.url),'utf8'));
const base = { ...backfills['401872923'][10].game, source: 'live' as const, isLive:true, status:'STATUS_IN_PROGRESS', homeScore:24,awayScore:24,clockSeconds:600,quarter:5,phase:'scrimmage' as const,down:1,distance:10,yardlineOwn:30,possession:'home' as const };
test('all 15 completed Week 1 games have valid histories and confirmed finals', () => {
  assert.equal(Object.keys(backfills).length,15);
  assert.equal(Object.values(backfills).reduce((n,a)=>n+a.length,0),2740);
  assert.ok(backfills['401872657']); assert.equal(backfills['401872931'],undefined);
  for(const samples of Object.values(backfills)) {
    assert.ok(samples.every(validSnapshot)); assert.equal(samples.at(-1)!.game.isLive,false);
    assert.equal(samples.at(-1)!.probabilities.finalTie,0);
    assert.ok(samples.every((p,i)=>!i || Number(p.playId)>Number(samples[i-1].playId)));
  }
});
test('OT replay uses pre-play scores, midfield and prior possessions without hindsight', () => {
  const raw=input(); const original=reconstructSummary(raw,1234);
  const find=(id:string)=>original.find(s=>s.playId===id)!;
  assert.deepEqual(find('4018729234879').game.overtime?.completed,{home:0,away:0});
  assert.equal(find('4018729234926').game.yardlineOwn,50); assert.equal(find('4018729235097').game.homeScore,24);
  assert.deepEqual(find('4018729235164').game.overtime?.completed,{home:1,away:0});
  assert.equal(find('4018729235164').game.timeoutsHome,2); assert.equal(find('4018729235442').game.awayScore,24);
  assert.ok(find('4018729235164').probabilities.finalTie != null); assert.equal(find('4018729235455').timestampEstimated,true);
  assert.equal(original.at(-1)!.game.clockSeconds,94);
  const all=raw.drives.previous.flatMap((d:{plays:Array<{id:string;sequenceNumber:string;homeScore:number}>})=>d.plays);
  const cutoff=Number(all.find((p:{id:string})=>p.id==='4018729235164').sequenceNumber);
  for(const p of all) if(Number(p.sequenceNumber)>cutoff) p.homeScore=55;
  assert.deepEqual(reconstructSummary(raw,1234).find(s=>s.playId==='4018729235164'),find('4018729235164'));
});
test('new-rule baseline uses the complete prior regular season and explicit smoothing',()=>{
  assert.equal(baseline.completedGames,272); assert.equal(baseline.games.length,14);
  assert.equal(baseline.games.filter(g=>g.teams[0].score===g.teams[1].score).length,1); assert.equal(FRESH_OT_TIE_RATE,.1);
  const p=liveProbabilities({...base,quarter:4,clockSeconds:120}); assert.ok(Math.abs(p.finalTie!/p.overtime!-.1)<1e-10);
});
test('OT simulator honors opening, response, sudden death and playoff state',()=>{
  const opening=overtimeScenario(base,'opening'); assert.ok(opening.finalTie!>.07 && opening.finalTie!<.13);
  assert.equal(opening.game.source,'demo'); assert.ok(overtimeScenario({...base,homeScore:27},'opening').error);
  const response=overtimeScenario({...base,homeScore:27,possession:'away',clockSeconds:180},'response');
  assert.deepEqual(response.game.overtime?.completed,{home:1,away:0}); assert.ok(response.finalTie != null);
  assert.equal(overtimeScenario({...base,seasonType:'postseason',overtimeRules:'postseason'},'opening').finalTie,0);
  assert.ok(overtimeScenario({...base,clockSeconds:1},'sudden_death').finalTie!>opening.finalTie!);
  assert.ok(overtimeScenario({...base,clockSeconds:0},'sudden_death').error);
});
test('halftime is silent even when forecasts are available',async()=>{
 const store=new Store(':memory:','live'),config={...readConfig({}),live:true};let calls=0;
 try{
  const halftime={...base,id:'401999991',quarter:2,clockSeconds:0,status:'STATUS_HALFTIME',fieldStateReliable:false};
  assert.equal(await publishGames([halftime],store,config,async()=>{calls++;return '101';},Date.now(),()=>{}),0);
  assert.equal(calls,0);assert.ok(store.pendingSnapshots().length>0);
 }finally{store.close();}
});
