import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store';
import { publishGames, publishPost, WELCOME_POST } from '../engine';
import { readConfig } from '../config';
import { nextPost } from '../policy';
import { EMPTY_HISTORY, type BotGame } from '../types';
import { quarterUpdate } from '../quarter-updates';
import { postTextWeight, XClient } from '../x-client';

const game: BotGame = {
  id:'401000111', homeTeam:'SEA', awayTeam:'NE', homeScore:10, awayScore:10,
  quarter:1, clockSeconds:0, clockLabel:'0:00', possession:'home', down:1, distance:10,
  yardlineOwn:30, timeoutsHome:3, timeoutsAway:3, phase:'scrimmage', tryType:'kick', pendingTryTeam:'home',
  overtimeRules:'current_regular', seasonType:'regular', source:'live', isLive:true,
  status:'STATUS_END_PERIOD', detail:'End of quarter', fieldStateReliable:false,
};
const config = { ...readConfig({}), live:true, maxForecastsPerDay:1 };
const noop = () => {};
const low = { overtime:.1, finalTie:.01 };

test('Q1, halftime and Q3 post once across restarts, with both probabilities and final recap', async () => {
  const dir=mkdtempSync(join(tmpdir(),'tiewon-quarters-')), path=join(dir,'state.sqlite');
  let store=new Store(path,'live'), now=Date.now();
  const sent: {text:string; parent?:string}[]=[];
  const send=async(text:string,parent?:string)=>{sent.push({text,parent}); return String(700+sent.length);};
  const poll=(g:BotGame,p=low)=>publishGames([g],store,config,send,now+=15000,noop,()=>p);
  try {
    assert.equal(await poll(game),1);
    store.close(); store=new Store(path,'live');
    assert.equal(await poll(game),0);
    assert.equal(await poll({...game,quarter:2,status:'STATUS_HALFTIME'}),1);
    assert.equal(await poll({...game,quarter:3}),1);
    assert.equal(await poll({...game,quarter:3}),0);
    // Subthreshold forecasts still contribute to peaks.
    await poll({...game,quarter:4,clockSeconds:180,status:'STATUS_IN_PROGRESS'}, {overtime:.19,finalTie:.019});
    assert.equal(await poll({...game,quarter:4,isLive:false,status:'STATUS_FINAL',homeScore:13},{overtime:0,finalTie:0}),1);
    assert.equal(sent.length,4);
    assert.match(sent[0].text,/END OF Q1/); assert.match(sent[1].text,/HALFTIME/); assert.match(sent[2].text,/END OF Q3/);
    assert.match(sent[3].text,/Final tie: 1.9%/); assert.match(sent[3].text,/OT \(before OT\): 19.0%/);
    assert.equal(sent[3].parent,'703');
    assert.equal(await poll({...game,quarter:4,isLive:false,status:'STATUS_FINAL',homeScore:13}),0);
  } finally {store.close();rmSync(dir,{recursive:true});}
});

test('queued quarters survive a busy slate and missing break status is labeled honestly',async()=>{
  const store=new Store(':memory:','live'); let n=0; const send=async()=>String(++n);
  const now=Date.now();
  try {
    const games=Array.from({length:7},(_,i)=>({...game,id:String(401000200+i)}));
    for(const [i,count] of [3,3,1].entries())
      assert.equal(await publishGames(games,store,config,send,now+i*15000,noop,()=>({overtime:null,finalTie:null})),count);
    const previous={...game,id:'401000299',clockSeconds:15,clockLabel:'0:15',status:'STATUS_IN_PROGRESS'};
    store.observe(previous,low,now);
    const current={...previous,quarter:2,clockSeconds:895,clockLabel:'14:55'};
    store.observe(current,low,now+15000);
    const post=nextPost(current,store.gameHistory(current.id),low.overtime,low)!;
    assert.match(post.text,/END OF Q1/); assert.match(post.text,/Latest: Q2 14:55 \(break missed\)/);
    assert.equal(quarterUpdate({...current,quarter:4},low,previous),null);
    assert.equal(quarterUpdate({...game,source:'demo'},low),null);
  } finally {store.close();}
});

test('OT emoji alert works and peaks exclude final outcomes and automatic OT certainty',async()=>{
  const store=new Store(':memory:','live'); const now=Date.now();
  try {
    store.observe({...game,quarter:4}, {overtime:.91,finalTie:.091},now);
    const ot={...game,quarter:5,clockSeconds:300,status:'STATUS_IN_PROGRESS'};
    store.observe(ot,{overtime:1,finalTie:.42},now+15000);
    const alert=nextPost(ot,store.gameHistory(game.id),.95)!;
    assert.match(alert.text,/🚨.*NUCLEAR TieWatch 🇹🇭⌚️/);
    assert.ok(postTextWeight(alert.text)<=280);
    let body: {text:string} | undefined;
    const client=new XClient({apiKey:'fake',apiSecret:'fake',accessToken:'fake',accessSecret:'fake'},async(_url,init)=>{
      body=JSON.parse(String(init?.body));return Response.json({data:{id:'801'}});
    });
    await client.post(alert.text); assert.equal(body!.text,alert.text);
    store.observe({...ot,isLive:false,status:'STATUS_FINAL'},{overtime:1,finalTie:1},now+30000);
    const history=store.gameHistory(game.id);
    assert.equal(history.peakTie,.42); assert.equal(history.peakOvertime,.91);
    const final=nextPost({...ot,isLive:false},history,1)!;
    assert.match(final.text,/IT'S A TIE/); assert.match(final.text,/42.0%/); assert.match(final.text,/91.0%/);
    assert.ok(postTextWeight(final.text)<=280);
  } finally {store.close();}
});

test('welcome uses the site link, accepts emoji, and does not duplicate or send in dry-run',async()=>{
  const store=new Store(':memory:','dry-run'); let calls=0;
  try {
    assert.match(WELCOME_POST.text,/https:\/\/tiewon.sbahirami.chatgpt.site/);
    assert.match(WELCOME_POST.text,/TieWatch 🇹🇭⌚️/);
    assert.ok(postTextWeight(WELCOME_POST.text)<=280);
    const send=async()=>{calls++;return '901';};
    assert.equal(await publishPost(WELCOME_POST,store,{...config,live:false},send,Date.now(),noop),true);
    assert.equal(await publishPost(WELCOME_POST,store,{...config,live:false},send,Date.now(),noop),false);
    assert.equal(calls,0);
    const client=new XClient({apiKey:'fake',apiSecret:'fake',accessToken:'fake',accessSecret:'fake'},async()=>{calls++;return Response.json({data:{id:'902'}});});
    await assert.rejects(client.post('🚨'.repeat(141)),/Invalid bot post text/);
    assert.equal(calls,0);
  } finally {store.close();}
});
