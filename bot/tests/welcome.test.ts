import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../store';
import { readConfig } from '../config';
import { publishWelcome, WELCOME_THREAD } from '../welcome';
import { publishPost } from '../engine';
import { XError, validatePostText } from '../x-client';

const config = { ...readConfig({}), live: true };
const noop = () => {};

test('welcome explains the features, fits text limits and replies to itself exactly once', async () => {
  const store = new Store(':memory:', 'live');
  const sent: { text: string; parent?: string }[] = [];
  const send = async (text: string, parent?: string) => { sent.push({text,parent}); return String(100+sent.length); };
  try {
    assert.equal(WELCOME_THREAD.length,6);
    for (const p of WELCOME_THREAD) validatePostText(p.text);
    const result = await publishWelcome(store,config,send,Date.now(),noop);
    assert.deepEqual(result,{published:6,complete:true});
    assert.equal(sent[0].parent,undefined);
    for (let i=1;i<sent.length;i++) assert.equal(sent[i].parent,String(100+i));
    assert.match(sent[3].text,/Thai Watch. TieWatch/);
    assert.match(sent[2].text,/still being brought online/);
    assert.match(sent[5].text,/peak observed/);
    assert.deepEqual(await publishWelcome(store,config,send,Date.now(),noop),{published:0,complete:true});
    assert.equal(sent.length,6);
  } finally {store.close();}
});

test('welcome resumes after a rate limit without repeating confirmed tweets', async () => {
  const store = new Store(':memory:','live'); const now=Date.now(); let calls=0;
  const parents: (string|undefined)[]=[];
  try {
    const send=async (_text:string,parent?:string)=>{
      calls++; if(calls===3) throw new XError(429,now+900000);
      parents.push(parent);return String(200+parents.length);
    };
    assert.deepEqual(await publishWelcome(store,config,send,now,noop),{published:2,complete:false});
    assert.deepEqual(await publishWelcome(store,config,send,now+901000,noop),{published:4,complete:true});
    assert.deepEqual(parents,[undefined,'201','202','203','204','205']);
  } finally {store.close();}
});

test('an existing root is reused and dry-run never calls X', async () => {
  const live=new Store(':memory:','live'), dry=new Store(':memory:','dry-run');
  try {
    await publishPost(WELCOME_THREAD[0],live,config,async()=> '301',Date.now(),noop);
    let firstParent: string | undefined, count=0;
    const result=await publishWelcome(live,config,async(_text,parent)=>{if(!count)firstParent=parent;return String(302+count++);},Date.now(),noop);
    assert.deepEqual(result,{published:5,complete:true});assert.equal(firstParent,'301');
    const preview=await publishWelcome(dry,{...config,live:false},async()=>{throw Error('Unexpected live request');},Date.now(),noop);
    assert.deepEqual(preview,{published:6,complete:true});
  } finally {live.close();dry.close();}
});
