import assert from 'node:assert/strict';
import test from 'node:test';
import {Store} from '../store';
import {publishGames} from '../engine';
import {readConfig} from '../config';
import {pregameLines,kickoffEstimate} from '../../web/lib/pregame';
import {nextPost} from '../policy';
import {EMPTY_HISTORY,type BotGame} from '../types';
import {validatePostText} from '../x-client';
const now=Date.now(),start=now+3600000;
const event={id:'401111111',date:new Date(start).toISOString(),season:{slug:'regular-season'},competitions:[{status:{type:{state:'pre',name:'STATUS_SCHEDULED'}},competitors:[{homeAway:'home',team:{abbreviation:'KC'}},{homeAway:'away',team:{abbreviation:'DEN'}}],odds:[{spread:-2.5}]}]};
const game:BotGame={id:event.id,startTime:event.date,homeTeam:'KC',awayTeam:'DEN',homeScore:0,awayScore:0,quarter:1,clockSeconds:900,clockLabel:'15:00',possession:'home',down:1,distance:10,yardlineOwn:30,timeoutsHome:3,timeoutsAway:3,phase:'scrimmage',tryType:'kick',pendingTryTeam:'home',overtimeRules:'current_regular',seasonType:'regular',source:'live',isLive:true,status:'STATUS_IN_PROGRESS',detail:'Live'};
test('only explicitly pregame, finite, timely spreads are accepted',()=>{
 assert.equal(pregameLines({events:[event]},now).length,1);
 assert.equal(pregameLines({events:[event]},start).length,0);
 for(const odds of [[{spread:NaN}],[{spread:null}],[{spread:'-2.5'}]]) assert.equal(pregameLines({events:[{...event,competitions:[{...event.competitions[0],odds}]}]},now).length,0);
 assert.equal(pregameLines({events:[{...event,competitions:[{...event.competitions[0],status:{type:{state:'in',name:'STATUS_IN_PROGRESS'}}}]}]},now).length,0);
});
test('kickoff uses spread buckets with an honest fallback and zero postseason tie chance',()=>{
 const line=pregameLines({events:[event]},now)[0]; const p=kickoffEstimate(game,line);
 assert.ok(p.overtime>.05&&p.overtime<.06);assert.equal(p.finalTie,p.overtime*.1);
 assert.equal(kickoffEstimate({...game,seasonType:'postseason'},line).finalTie,0);
 assert.match(kickoffEstimate(game,{...line,homeTeam:'DET'}).basis,/unavailable/);
 assert.match(kickoffEstimate(game,{...line,capturedAt:start+1}).basis,/unavailable/);
 assert.match(kickoffEstimate(game).basis,/unavailable/);
});
test('kickoff and late-Q1 tracking stay silent while pregame history is preserved',async()=>{
 const store=new Store(':memory:','live'); const config={...readConfig({}),live:true}; let calls=0;
 try {
  store.savePregame(pregameLines({events:[event]},now));
  assert.equal(store.pregame(game.id)?.spread,-2.5);
  for(const g of [game,{...game,clockSeconds:450},{...game,clockSeconds:0,status:'STATUS_END_PERIOD'}]){
   assert.equal(await publishGames([g],store,config,async()=>{calls++;return '801';},start,()=>{}),0);
   assert.equal(nextPost(g,EMPTY_HISTORY,.1,{overtime:.1,finalTie:.01}),null);
  }
  assert.equal(calls,0); assert.ok(store.pendingSnapshots().length>0);
 }finally{store.close();}
});

test('tie celebration requires a confirmed regular-season OT final and fits X',()=>{
 const final={...game,quarter:5,isLive:false,status:'STATUS_FINAL',homeScore:100,awayScore:100};
 const p=nextPost(final,{...EMPTY_HISTORY,followed:true,peakTie:null,peakOvertime:null},1)!;
 assert.equal(p.text.split('🇹🇼').length-1,6);
 assert.match(p.text,/🎉🎉🎉/);assert.match(p.text,/MISSION ACCOMPLISHED/);assert.match(p.text,/TieWatch 🇹🇭⌚️/);validatePostText(p.text);
 assert.equal(nextPost({...final,seasonType:'postseason'},EMPTY_HISTORY,1),null);
 assert.doesNotMatch(nextPost({...final,isLive:true},EMPTY_HISTORY,.1)!.text,/MISSION ACCOMPLISHED/);
});
