import assert from 'node:assert/strict';
import test from 'node:test';
import { FRESH_OT_TIE_RATE, predictFinalTie } from '../../web/lib/ot-model';
import { overtimeScenario } from '../../web/lib/ot-scenario';
import { backfills } from '../../web/lib/backfills';
import { simulateTieProbability } from '../../web/lib/monte-carlo';
const base = { ...backfills['401872923'][10].game, homeScore:24, awayScore:24, clockSeconds:600, quarter:5,
  phase:'scrimmage' as const, down:1, distance:10, yardlineOwn:30, possession:'home' as const, timeoutsHome:2, timeoutsAway:2 };

test('opening joint branch calibration matches weighted baseline within Monte Carlo tolerance', () => {
  assert.ok(Math.abs(FRESH_OT_TIE_RATE - .070481444333) < 1e-10);
  const result = overtimeScenario(base,'opening');
  assert.ok(Math.abs(result.finalTie! - FRESH_OT_TIE_RATE) < .006, String(result.finalTie));
});

test('regulation Monte Carlo also uses the current-rule branch mixture', () => {
  const p = simulateTieProbability({...base,quarter:4,clockSeconds:0},20000);
  assert.equal(p.estimate,1);
  assert.ok(Math.abs(p.finalDraw - FRESH_OT_TIE_RATE) < .008, String(p.finalDraw));
  assert.ok(Math.abs(p.homeWin+p.awayWin+p.finalDraw-1)<1e-10);
});

test('first-drive branch changes response estimates, which remain sensitive to time and field', () => {
  const td = overtimeScenario({...base,awayScore:31,clockSeconds:300},'response');
  const fg = overtimeScenario({...base,awayScore:27,clockSeconds:300},'response');
  const no = overtimeScenario({...base,clockSeconds:300},'response');
  assert.ok(td.finalTie! < .01, String(td.finalTie));
  assert.ok(fg.finalTie! > td.finalTie!);
  assert.ok(no.finalTie! > td.finalTie!);
  const late = overtimeScenario({...base,clockSeconds:30},'response');
  assert.ok(late.finalTie! > no.finalTie!);
  const redzone = overtimeScenario({...base,clockSeconds:300,yardlineOwn:95},'response');
  assert.notEqual(redzone.finalTie, no.finalTie);
  for (const r of [td,fg,no,late,redzone]) assert.ok(r.finalTie! >= 0 && r.finalTie! <= 1);
});

test('known first-drive outcome survives sudden death and provider finals override forecasts', () => {
  const g = overtimeScenario({...base,clockSeconds:120},'sudden_death').game;
  const td = {...g,overtime:{...g.overtime!,firstDriveOutcome:'touchdown' as const}};
  const fg = {...g,overtime:{...g.overtime!,firstDriveOutcome:'fieldGoal' as const}};
  assert.ok(predictFinalTie(td)! < predictFinalTie(fg)!);
  assert.equal(predictFinalTie({...td,isLive:false}),1);
  assert.equal(predictFinalTie({...fg,isLive:false,homeScore:27}),0);
  assert.equal(predictFinalTie({...td,seasonType:'postseason',overtimeRules:'postseason'}),0);
});
