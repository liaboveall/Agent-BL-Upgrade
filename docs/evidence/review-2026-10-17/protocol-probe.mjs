/* global describe, it, after */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { cargoIdentityHash } from '../../../src/chain/cargoIdentity.js';
import { deployProtocol,newOffering,send,applyPricing,ACTION,STATE,ethers } from '../../../hardhat/test/helpers/protocol.js';
const observations=[];
describe('Independent review: protocol lifecycle probes',()=>{
 it('records two offerings for the same physical bill under distinct application case ids',async()=>{
  const c=await deployProtocol();
  const bill={bl_id:'SAME-BILL-REVIEW',carrier:'Review Carrier',vessel:'Review Vessel',voyage:'V1',cargo:'Copper',quantity_mt:500};
  const a={case_id:'REVIEW-DUP-A',bill_of_lading:bill},b={...a,case_id:'REVIEW-DUP-B'};
  const hashes=[cargoIdentityHash(a),cargoIdentityHash(b)];
  const metadata={vessel:bill.vessel,voyage:bill.voyage,portOfLoading:'Singapore',portOfDischarge:'Shanghai',cargo:bill.cargo,quantity:500,quantityUnit:'MT',hsCode:'740311',declaredValueUsdE6:1000000n,incoterms:'CIF',mletr:true,eucp:true,dcsa:true};
  const ids=[];
  for(const hash of hashes){await send(c.registry.mintEBLV2(hash,ethers.id('same-document'),c.owner.address,metadata));const id=await c.registry.nextEblId()-1n;await send(c.registry.pledge(id,await c.pool.getAddress()));await send(c.pool.createOffering(id,100n,800000n,1000000n));ids.push(String(id));}
  observations.push({scenario:'case_id_changes_cargo_identity',sameBill:bill.bl_id,cargoHashes:hashes,eblIds:ids,offeringCount:String(await c.pool.nextPoolId()-1n),requiresOwner:true});
 });
 it('records whether repricing reopens an in-transit pool',async()=>{
  const c=await deployProtocol(); const {poolId}=await newOffering(c,'review-in-transit');
  await send(c.pool.connect(c.investor).subscribe(poolId,20n));
  await send(c.pool.connect(c.agent).markInTransit(poolId,ethers.id('review-departure')));
  assert.equal(await c.pool.stateOf(poolId),STATE.InTransit);
  let beforeRejected=false;try{await c.pool.connect(c.other).subscribe.staticCall(poolId,10n);}catch{beforeRejected=true;}
  await send(applyPricing(c,poolId,700000n,ACTION.REPRICE_DOWN));
  const repriced=await c.pool.stateOf(poolId);
  await send(c.pool.connect(c.other).subscribe(poolId,10n));
  observations.push({scenario:'in_transit_reopens',beforeRejected,repriced:String(repriced),afterSubscription:String(await c.pool.stateOf(poolId)),subscribed:String((await c.pool.offerings(poolId)).subscribed)});
 });
 it('records whether REPRICE prevents a fully funded pool from departing',async()=>{
  const c=await deployProtocol();const {poolId}=await newOffering(c,'review-funded');
  await send(c.pool.connect(c.investor).subscribe(poolId,100n));
  await send(applyPricing(c,poolId,700000n,ACTION.REPRICE_DOWN));
  let departureError='';try{await c.pool.connect(c.agent).markInTransit.staticCall(poolId,ethers.id('d'));}catch(e){departureError=e.shortMessage||e.message;}
  let subscribeError='';try{await c.pool.connect(c.other).subscribe.staticCall(poolId,1n);}catch(e){subscribeError=e.shortMessage||e.message;}
  observations.push({scenario:'funded_dead_end',state:String(await c.pool.stateOf(poolId)),departureError,subscribeError});
 });
 it('records whether repayment below target is marked repaid and releases collateral',async()=>{
  const c=await deployProtocol();const {eblId,poolId}=await newOffering(c,'review-underpayment');
  await send(c.pool.connect(c.investor).subscribe(poolId,100n));
  await send(c.pool.connect(c.agent).recordImporterPayment(poolId,ethers.id('payment'),1n));
  await send(c.pool.connect(c.agent).recordCargoArrival(poolId,ethers.id('arrival')));
  await send(c.pool.connect(c.agent).settle(poolId,1n));
  observations.push({scenario:'underpayment',state:String(await c.pool.stateOf(poolId)),repaymentAtomic:String((await c.pool.offerings(poolId)).repaymentAmount),targetAtomic:'100000000',pledgedTo:await c.registry.pledgedTo(eblId)});
 });
 after(async()=>{await fs.writeFile(new URL('./protocol-probes.json', import.meta.url),JSON.stringify(observations,null,2));console.log(JSON.stringify(observations,null,2));});
});
