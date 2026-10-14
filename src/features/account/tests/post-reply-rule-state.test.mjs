// The reply-rule picker's state, driven through its real controller with the network reads stubbed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reactiveFixture } from '../../../../scripts/svelte-test.mjs'
const {picker,gates,flushSync} = await reactiveFixture(new URL('./fixtures/post-reply-rule.svelte.ts', import.meta.url))
async function settle(){for(let i=0;i<10;i++){flushSync();await Promise.resolve()}}

test('closed pickers do no reads and key choices wait for matching market and activation',async()=>{
 const sent=[],view=picker(async gate=>sent.push(gate))
 try{
  await settle();assert.equal(view.state.reads,0);assert.equal(view.state.keyReads,0)
  view.open();await settle();assert.equal(view.state.reads,1);assert.equal(view.state.keyReads,1)
  for(const state of ['loading','failed','inactive','unavailable']){
   view.setStatus(state);await settle();await view.choose('keys');assert.deepEqual(sent,[])
  }
  view.setStatus('active');await settle();assert.equal(view.state.available,true)
  view.mismatch();await settle();await view.choose('keys');assert.deepEqual(sent,[])
  await view.choose('all');assert.deepEqual(sent,[gates.block])
 }finally{view.stop()}
})
test('rejected selections restore the real gate, and pending selections or notes cannot leak across accounts',async()=>{
 let reject;const view=picker(()=>new Promise((_,no)=>{reject=no}))
 try{
  view.open();await settle()
  const saving=view.choose('all');await settle();assert.equal(view.state.selected,'all');assert.equal(view.state.busy,true)
  reject(Error('wallet rejected'));await saving;await settle()
  assert.equal(view.state.selected,'default');assert.equal(view.state.note.text,'wallet rejected')
  const again=view.choose('keys');await settle();assert.equal(view.state.selected,'keys')
  view.change();await settle();assert.equal(view.state.selected,'default');assert.equal(view.state.note,null)
  reject(Error('late refusal'));await again;await settle();assert.equal(view.state.note,null)
 }finally{view.stop()}
})

test('closed summaries show the effective default and shorten empty blocklists for either rule',async()=>{
 const view=picker(async()=>{})
 try{
  await settle();assert.equal(view.summary,'reply rule');assert.equal(view.detail,null)
  view.open();await settle();assert.equal(view.summary,'reply rule · all');assert.equal(view.detail,'all')
  for(const [gate,label] of [[gates.block,'all'],[gates.keys,'key holders']]){
   view.label(gate,false);await settle();assert.equal(view.summary,`reply rule · ${label}`);assert.equal(view.detail,label)
   view.label(gate,true);await settle();assert.equal(view.summary,`reply rule · ${label} except blocked`);assert.equal(view.detail,`${label} except blocked`)
  }
 }finally{view.stop()}
})


test('blocklist and closing choices work without account keys or a matching market', async()=>{
 const sent=[],view=picker(async gate=>sent.push(gate))
 try{
  view.setStatus('inactive');view.mismatch();view.open();await settle()
  assert.equal(view.state.available,false)
  await view.choose('keys');assert.deepEqual(sent,[])
  await view.choose('all');await view.choose('closed')
  assert.deepEqual(sent,[gates.block,gates.closed])
 }finally{view.stop()}
})

test('a draft choice shows only in the picker, while a post change confirms it landed',async()=>{
 const draft=picker(async()=>{})
 try{draft.open();await settle();await draft.choose('closed');await settle();assert.equal(draft.state.note,null)}finally{draft.stop()}
 const post=picker(async()=>{},7n)
 try{post.open();await settle();await post.choose('closed');await settle();assert.equal(post.state.note?.text,'reply rule saved')}finally{post.stop()}
})

for (const change of ['gate', 'disabled']) test(`changing the ${change} reads neither the account rule nor the keys again`, async () => {
  const view = picker(async () => {})
  try {
    view.open(); await settle()
    assert.equal(view.state.reads, 1)
    if (change === 'gate') view.setGate(gates.closed)
    else view.setDisabled(true)
    await settle()
    assert.equal(view.state.reads, 1, 'only the account/chain or explicit retry should reload the rule')
    assert.equal(view.state.keyReads, 1, 'the key status should not reload either')
  } finally { view.stop() }
})
test('choosing a draft rule keeps a working picker usable while the network is down', async () => {
  const view = picker(async () => {})
  try {
    view.open(); await settle()
    view.failReads()
    view.setGate(gates.closed); await settle()
    assert.equal(view.readFailed, false, 'a local selection must not turn a healthy picker into an error')
  } finally { view.stop() }
})
