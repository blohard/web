import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { decodeFunctionData, zeroAddress } from 'viem'
import { load, install, teardown, mock, author, address, replyArgs, posted, gateChanged } from '../../../../scripts/host-harness.mjs'
const { accountReplyLabel } = await load('features/publishing/reply-rules.ts')
const { savePostReplyGate, currentPostReplyGate } = await load('features/account/post-reply-rule.ts')
const { postReplyChoice } = await load('features/publishing/reply-rules.ts')
const { publishPost } = await load('features/publishing/posting.ts')
const { recoverPost } = await load('features/publishing/recovery.ts')
const { boardAbi } = await load('lib/abi/board.ts')
const { gates } = await load('lib/gates.svelte.ts')
const { TOMBSTONE } = await load('lib/board.ts')
const { RelayUnknown } = await load('features/publishing/relay.ts')
const { DraftBox } = await load('features/publishing/draft-box.svelte.ts')
beforeEach(() => {install();mock.chain.key_gates={holders:address('98'),holders_blocklist:address('99')}})
after(teardown)

test('account default is distinct from explicit rules and accurately describes custom or deactivated defaults',()=>{
  const c=mock.chain
  assert.equal(postReplyChoice(c,zeroAddress),'default')
  assert.equal(postReplyChoice(c,c.blocking.gate),'all')
  assert.equal(postReplyChoice(c,c.key_gates.holders_blocklist),'keys')
  assert.equal(postReplyChoice(c,c.key_gates.holders),'other')
  assert.equal(accountReplyLabel(c,zeroAddress,true),'all')
  assert.equal(accountReplyLabel(c,zeroAddress,false),'all without block enforcement')
  assert.equal(accountReplyLabel(c,c.blocking.gate,false),'all except blocked')
  assert.equal(accountReplyLabel(c,c.key_gates.holders_blocklist,true),'key holders')
  assert.equal(accountReplyLabel(c,TOMBSTONE,false),'account deactivated')
  assert.equal(accountReplyLabel(c,address('77'),true),'custom gate')
})
for(const sponsored of [true,false]) for(const parentId of [0n, 6n]) {
  test(`${sponsored?'sponsored':'paid'} publication under ${parentId} includes the chosen gate in its exact signed or estimated call`,async()=>{
    const args={...replyArgs(),parentId,sponsored,replyGate:mock.chain.blocking.gate}
    mock.logs=[posted(args.pending, parentId)]
    mock.relayStatus=200
    await publishPost(args)
    if(sponsored){
      const typed=JSON.parse(mock.calls.find(c=>c.method==='eth_signTypedData_v4').params[1])
      assert.equal(typed.message.replyGate,args.replyGate)
      assert.equal(mock.calls.find(c=>c.method==='relay').signed.replyGate,args.replyGate)
    }else{
      const call=decodeFunctionData({abi:boardAbi,data:mock.calls.find(c=>c.method==='eth_sendTransaction').params[0].data})
      assert.equal(call.args[2].toLowerCase(),args.replyGate)
      assert.equal(mock.calls.find(c=>c.method==='post-estimate').reply_gate,args.replyGate)
    }
  })
}
test('an uncertain sponsored send recovers the originally chosen rule without signing again',async()=>{
  const args={...replyArgs(),parentId:0n,replyGate:mock.chain.blocking.gate}
  mock.relayStatus=0
  await assert.rejects(publishPost(args),RelayUnknown)
  const signed={...args.pending.signed}
  assert.equal(signed.replyGate,args.replyGate)
  mock.relayStatus=200;mock.logs=[posted(args.pending)]
  await recoverPost(mock.chain,args.pending)
  assert.equal(mock.calls.filter(c=>c.method==='eth_signTypedData_v4').length,1)
  assert.deepEqual(mock.calls.findLast(c=>c.method==='relay').signed,signed)
})
for(const choice of ['default','all','keys']){
  test(`saving ${choice} on a post pays wallet gas and updates the shared ledger from the receipt`,async()=>{
    const gate=choice==='default'?zeroAddress:choice==='all'?mock.chain.blocking.gate:mock.chain.key_gates.holders_blocklist
    await gates.ensureMessage(mock.chain,9n)
    gateChanged(9n,gate,12n)
    const {wallet}=replyArgs()
    await savePostReplyGate(wallet,mock.chain,{id:9n,parentId:1n,author},gate)
    assert.equal(gates.message(mock.chain,9n),gate)
    const sent=mock.calls.find(c=>c.method==='eth_sendTransaction')
    assert.deepEqual(decodeFunctionData({abi:boardAbi,data:sent.params[0].data}),{functionName:'setReplyGate',args:[9n,gate]})
    assert.equal(mock.calls.some(c=>['relay','eth_signTypedData_v4'].includes(c.method)),false)
  })
}
test('deleted posts, other authors and unsupported rules cannot use the picker write path',async()=>{
  const {wallet}=replyArgs(),post={id:9n,parentId:0n,author}
  for(const changed of [{...post,author:address('77')}])await assert.rejects(savePostReplyGate(wallet,mock.chain,changed,zeroAddress))
  await assert.rejects(savePostReplyGate(wallet,mock.chain,post,address('77')),/not available/)
  mock.gates.set(9n,TOMBSTONE)
  await assert.rejects(savePostReplyGate(wallet,mock.chain,post,zeroAddress),/deleted/)
  assert.equal(mock.calls.some(c=>c.method==='eth_sendTransaction'),false)
})
test('wallet switches and reverted gate edits leave the displayed rule unchanged',async()=>{
  const {wallet}=replyArgs(),post={id:9n,parentId:0n,author}
  await gates.ensureMessage(mock.chain,9n)
  wallet.ensureChain=async()=>{wallet.account=address('77')}
  await assert.rejects(savePostReplyGate(wallet,mock.chain,post,mock.chain.blocking.gate),/changed accounts/)
  assert.equal(mock.calls.some(c=>c.method==='eth_sendTransaction'),false)
  wallet.account=author;wallet.ensureChain=async()=>{};mock.receiptStatus='0x0'
  await assert.rejects(savePostReplyGate(wallet,mock.chain,post,mock.chain.blocking.gate))
  assert.equal(gates.message(mock.chain,9n),zeroAddress)
})
test('draft reply rules survive edits and failed sends, remain account-scoped, and clear with the submitted draft',()=>{
  const box=new DraftBox(),context='chain:board:alice',gate=address('44')
  box.setReplyGate(context,gate)
  box.edit({...box.draft,text:'hello'})
  box.fail(box.begin())
  assert.equal(box.replyGate(context),gate)
  assert.equal(box.replyGate('chain:board:bob'),zeroAddress)
  assert.equal(box.replyGate('other:board:alice'),zeroAddress)
  const sent=box.begin()
  box.setReplyGate(context,zeroAddress)
  assert.equal(box.finish(sent),false,'late completion must not erase a newer rule choice')
  box.setReplyGate(context,gate)
  box.finish(box.begin())
  assert.equal(box.replyGate(context),zeroAddress)
})

test('draft submission checks fresh published gates and never substitutes another explicit address',async()=>{
  const c=mock.chain, gate=c.blocking.gate
  assert.equal(await currentPostReplyGate(c,author,zeroAddress),zeroAddress)
  assert.equal(mock.calls.length,0,'account default needs no extra request')
  mock.publishedStatus={chains:[{...c,blocking:null,key_gates:null}],keyrings:[]}
  assert.equal(await currentPostReplyGate(c,author,gate),zeroAddress)
  mock.publishedStatus={chains:[{...c,blocking:{...c.blocking,gate:address('77')}}],keyrings:[]}
  assert.equal(await currentPostReplyGate(c,author,gate),zeroAddress)
  mock.publishedStatus={chains:[c],keyrings:[]}
  assert.equal(await currentPostReplyGate(c,author,gate),gate)
  assert.equal(await currentPostReplyGate(c,author,c.key_gates.holders_blocklist),zeroAddress,'unmatched key market cannot keep the selected gate')
  mock.hostStatus=503
  await assert.rejects(currentPostReplyGate(c,author,gate),'a failed status request must not silently change the rule')
})
test('a stale draft rule is replaced with account default before paid or sponsored signing',async()=>{
  for(const sponsored of [true,false]){
    install()
    const warnings=[],args={...replyArgs(),parentId:0n,sponsored,replyGate:mock.chain.blocking.gate,onWarn:s=>warnings.push(s)}
    mock.publishedStatus={chains:[{...mock.chain,blocking:null}],keyrings:[]}
    mock.logs=[posted(args.pending)];mock.relayStatus=200
    await publishPost(args)
    const gate=sponsored?args.pending.signed.replyGate:decodeFunctionData({abi:boardAbi,data:mock.calls.find(c=>c.method==='eth_sendTransaction').params[0].data}).args[2]
    assert.equal(gate,zeroAddress)
    assert.ok(warnings.some(s=>s.includes('account default')))
  }
})
test('a pending rule change excludes deletion across mounted copies and releases on rejection',async()=>{
  const { moderate }=await load('features/messages/moderation.ts'),{ messageActions }=await load('features/messages/message-actions.svelte.ts')
  const {wallet}=replyArgs(),post={id:9n,parentId:0n,author}
  let reject
  wallet.ensureChain=()=>new Promise((_,no)=>{reject=no})
  const saving=savePostReplyGate(wallet,mock.chain,post,zeroAddress)
  for(let i=0;i<25&&!reject;i++)await new Promise(resolve=>setTimeout(resolve,0))
  assert.equal(messageActions.busy(mock.chain,post.id),true)
  await assert.rejects(moderate(wallet,mock.chain,post.id,'delete'),/still pending/)
  await assert.rejects(savePostReplyGate(wallet,mock.chain,post,zeroAddress),/still pending/)
  reject(Error('wallet rejected'));await assert.rejects(saving,/wallet rejected/)
  assert.equal(messageActions.busy(mock.chain,post.id),false)
  assert.equal(mock.calls.some(c=>c.method==='eth_sendTransaction'),false)
})

test('reading picker account state does not advance the visible message ledger',async()=>{
  const {authorGate}=await load('lib/board.ts')
  await gates.ensureMessage(mock.chain,9n)
  const before=gates.message(mock.chain,9n)
  gateChanged(9n,TOMBSTONE,12n)
  await authorGate(mock.chain,author)
  assert.equal(gates.message(mock.chain,9n),before)
})
