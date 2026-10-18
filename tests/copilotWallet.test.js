import test from 'node:test';
import assert from 'node:assert/strict';
import { subscribeOffering } from '../web/src/lib/web3.js';

function walletFixture() {
 const address='0x2222222222222222222222222222222222222222',contractAddress='0x1111111111111111111111111111111111111111',asset='0x4444444444444444444444444444444444444444',hash='0x'+'a'.repeat(64);
 const action={shares:'1250',chain:{pool_id:2,chain_id:1439,contract:contractAddress,price_e6:'800000'}};
 let network='0x59f',accounts=[address],current=null,sends=0,simulations=0;
 const session={kind:'evm',address,signer:{},provider:{request:async({method})=>method==='eth_chainId'?network:method==='eth_getBlockByNumber'?{timestamp:'0x1000'}:accounts}};current=session;
 const offering={exists:true,state:2n,issuePrice:800000n,tokenSupply:10000n,subscribed:0n,settlementAsset:asset};
 const event={name:'Subscribed',args:{poolId:2n,investor:address,amount:1250n,paidAmount:1000000000n}};
 const escrow={name:'FundEscrowed',args:{poolId:2n,investor:address,asset,amountAtomic:1000000000n,shares:1250n}};
 const receipt={status:1,blockNumber:42,logs:[{address:contractAddress,kind:'subscription'},{address:contractAddress,kind:'escrow'}]};
 const subscribeWithTerms=Object.assign(async(pool,shares)=>{assert.equal(pool,2n);assert.equal(shares,1250n);sends++;return{hash,wait:async()=>receipt};},{staticCall:async()=>{simulations++;}});
 const contract={protocolVersion:async()=>5n,quoteVersion:async()=>1n,subscriptionDeadline:async()=>99999n,offerings:async()=>offering,emergencyStopped:async()=>false,isInvestorEligible:async()=>true,subscribeWithTerms,interface:{parseLog:log=>log.kind==='escrow'?escrow:event,encodeFunctionData:()=> '0x1234'}};
 const usdc={decimals:async()=>6,allowance:async()=>1000000000n};
 const options={getSession:()=>current,getConfig:async()=>({protocolVersion:5,chainIdDecimal:1439,contracts:{RWAOfferingPool:contractAddress},abis:{RWAOfferingPool:[]},explorerBase:'https://explorer.example'}),ethersFn:async()=>({Contract:class{constructor(target){return target===asset?usdc:contract;}}}),prepareIntent:async()=>({intent_id:'fixture',asset,amount_atomic:'1000000000',calldata:'0x1234'}),attachIntent:async()=>({status:'confirmed'})};
 return{action,options,offering,event,receipt,contract,counts:()=>({sends,simulations}),network:value=>{network=value;},account:value=>{accounts=[value];},disconnect:()=>{current=null;}};
}

test('Copilot wallet: a matching contract receipt is required for a Live subscription result', async () => {
  const f = walletFixture(); const result = await subscribeOffering(f.action, f.options);
  assert.equal(result.mode, 'chain'); assert.equal(result.txHash, '0x' + 'a'.repeat(64));
  assert.equal(result.amountUsd, 1000); assert.equal(result.tokenCount, '1250');
  assert.equal(result.blockNumber, 42); assert.deepEqual(f.counts(), { sends: 1, simulations: 1 });
});

test('Copilot wallet: deployment, account, network, price, capacity, eligibility and stopped pools refuse before signing', async () => {
  for (const change of ['deployment', 'network', 'account', 'price', 'capacity', 'eligibility', 'stop']) {
    const f = walletFixture();
    if (change === 'deployment') f.action.chain.contract = '0x3333333333333333333333333333333333333333';
    if (change === 'network') f.network('0x1');
    if (change === 'account') f.account('0x3333333333333333333333333333333333333333');
    if (change === 'price') f.offering.issuePrice = 900000n;
    if (change === 'capacity') f.offering.subscribed = 9999n;
    if (change === 'eligibility') f.contract.isInvestorEligible = async () => false;
    if (change === 'stop') f.contract.emergencyStopped = async () => true;
    await assert.rejects(subscribeOffering(f.action, f.options)); assert.equal(f.counts().sends, 0, change);
  }
});

test('Copilot wallet: a wallet or mode change after static simulation prevents broadcast', async () => {
  for (const change of ['disconnect', 'mode']) {
    const f = walletFixture(); let changed = false;
    f.contract.subscribeWithTerms.staticCall = async () => { changed = true; if (change === 'disconnect') f.disconnect(); };
    await assert.rejects(subscribeOffering(f.action, { ...f.options, assertCurrent: () => { if (changed && change === 'mode') throw new Error('mode changed'); } }));
    assert.equal(f.counts().sends, 0);
  }
});

test('Copilot wallet: wrong events, failed receipts and price changes during mining remain unconfirmed without automatic retry', async () => {
  for (const change of ['event', 'failed', 'price', 'foreign_contract']) {
    const f = walletFixture();
    if (change === 'event') f.event.args.amount = 1n;
    if (change === 'failed') f.receipt.status = 0;
    if (change === 'price') f.event.args.paidAmount = 2000000000n;
    if (change === 'foreign_contract') f.receipt.logs[0].address = '0x3333333333333333333333333333333333333333';
    await assert.rejects(subscribeOffering(f.action, f.options), { code: 'subscription_reconciliation_required' });
    assert.equal(f.counts().sends, 1);
  }
});
