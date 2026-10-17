// Model-based test of the RWAOfferingPool state machine.
//
// A small reference model of the intended rules runs side by side with the real
// contracts on seeded pseudo-random operation sequences. Before every call the model
// predicts whether it must succeed; afterwards the on-chain state of the touched pool
// and eBL has to equal the model, and a set of global invariants has to hold. A
// disagreement prints the seed, the step and the operation, so it can be replayed.
import { expect } from 'chai';
import { ACTION, ISSUE_PRICE, TARGET, applyPricing, deployProtocol, ethers, send, uniqueHash } from './helpers/protocol.js';

const S = { Open: 2, Subscribed: 3, Funded: 4, InTransit: 5, Repriced: 6, Paused: 7, Frozen: 8, Repaid: 9, Liquidation: 11, Cancelled: 12 };
const STATE_NAME = Object.fromEntries(Object.entries(S).map(([name, code]) => [code, name]));
const isActive = (state) => [S.Open, S.Subscribed, S.Funded, S.InTransit, S.Repriced].includes(state);
const isTerminal = (state) => state === S.Repaid || state === S.Cancelled;
const target = Number(TARGET);
const startPrice = Number(ISSUE_PRICE);

function mulberry32(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n) => Math.floor(next() * n), chance: (p) => next() < p };
}

function pickWeighted(rng, table) {
  const total = table.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng.next() * total;
  for (const [name, weight] of table) {
    roll -= weight;
    if (roll < 0) return name;
  }
  return table[table.length - 1][0];
}

const OPERATIONS = [
  ['createOffering', 6], ['pledge', 3], ['registryRelease', 2],
  ['subscribe', 18], ['markInTransit', 7], ['agentPause', 3], ['ownerPause', 2], ['resume', 5],
  ['pricing', 22], ['recordPayment', 9], ['correctPayment', 3], ['recordArrival', 7], ['settle', 11],
  ['cancel', 3], ['emergencyToggle', 2]
];

/** A revert is the expected "failure"; anything else (RPC, nonce, ...) is a test bug. */
async function attempt(factory) {
  try {
    await send(factory());
    return true;
  } catch (error) {
    if (/revert|VM Exception/iu.test(String(error?.message))) return false;
    throw error;
  }
}

function describeOperation(op) {
  return `${op.kind}${op.pool ? ` pool#${op.pool.id}(${STATE_NAME[op.pool.state]})` : ''} ${JSON.stringify(op.args ?? {}, (key, value) => (typeof value === 'bigint' ? value.toString() : value))}`;
}

/** Predict, execute and apply one random operation. Returns the touched pool (if any). */
function planOperation(kind, ctx, model, rng) {
  // Frozen keeps the investors' claim: verified recovery may still arrive and settle (A02).
  const settleable = (pool) => !model.emergency && (isActive(pool.state) || pool.state === S.Frozen) && pool.subscribed > 0;
  // Mostly pick a pool for which the operation is meaningful, so the walk reaches deep
  // states (Funded, Repaid, ...) instead of dying early; 25% of the time pick any pool to
  // keep probing illegal moves.
  const preferred = {
    subscribe: (q) => [S.Open, S.Repriced, S.Subscribed].includes(q.state),
    markInTransit: (q) => [S.Funded, S.Subscribed].includes(q.state),
    resume: (q) => q.state === S.Paused,
    recordPayment: (q) => settleable(q) && q.payment === null,
    correctPayment: (q) => q.payment !== null && isActive(q.state),
    recordArrival: (q) => settleable(q) && !q.arrival,
    settle: (q) => settleable(q) && q.payment !== null && q.arrival,
    cancel: (q) => [S.Open, S.Repriced, S.Paused].includes(q.state) // with and without subscribers
  }[kind];
  let p = model.pools.length ? model.pools[rng.int(model.pools.length)] : null;
  if (preferred && rng.chance(0.75)) {
    const matching = model.pools.filter(preferred);
    if (matching.length) p = matching[rng.int(matching.length)];
  }
  const poolContract = ctx.pool;
  const agent = ctx.pool.connect(ctx.agent);
  const investor = [ctx.investor, ctx.outsider, ctx.other][rng.int(3)];

  const releaseCollateral = (pool) => {
    const ebl = model.ebls[pool.e];
    if (ebl.offeredBy === pool.id) ebl.offeredBy = 0;
    ebl.pledged = false; // released (or it was already released out of band)
  };

  switch (kind) {
    case 'createOffering': {
      const free = model.ebls.map((ebl, index) => (ebl.pledged && ebl.offeredBy === 0 ? index : -1)).filter((index) => index >= 0);
      const e = free.length && rng.chance(0.8) ? free[rng.int(free.length)] : rng.int(model.ebls.length);
      const supply = 2 + rng.int(5);
      const ebl = model.ebls[e];
      return {
        kind, args: { eblId: e + 1, supply },
        ok: !model.emergency && ebl.pledged && ebl.offeredBy === 0,
        run: () => poolContract.createOffering(e + 1, supply, ISSUE_PRICE, TARGET),
        apply: () => {
          const pool = { id: model.pools.length + 1, e, supply, price: startPrice, subscribed: 0, state: S.Open, before: 0, payment: null, arrival: false };
          model.pools.push(pool);
          ebl.offeredBy = pool.id;
          return pool;
        }
      };
    }
    case 'pledge': {
      const e = rng.int(model.ebls.length);
      return {
        kind, args: { eblId: e + 1 }, ok: !model.ebls[e].pledged,
        run: () => ctx.registry.pledge(e + 1, ctx.pool.getAddress()),
        apply: () => { model.ebls[e].pledged = true; }
      };
    }
    case 'registryRelease': {
      // Mostly release the pledge of an eBL that backs an offering still open for
      // subscriptions: the dangerous case (shares must not be sold against it).
      const live = model.pools.filter((q) => [S.Open, S.Repriced, S.Subscribed].includes(q.state) && q.subscribed < q.supply && model.ebls[q.e].pledged);
      const e = live.length && rng.chance(0.8) ? live[rng.int(live.length)].e : rng.int(model.ebls.length);
      return {
        kind, args: { eblId: e + 1 }, ok: false,
        run: () => ctx.registry.releasePledge(e + 1),
        apply: () => { model.ebls[e].pledged = false; }
      };
    }
    case 'emergencyToggle':
      return {
        kind, args: { to: !model.emergency }, ok: true,
        run: () => poolContract.setEmergencyStop(!model.emergency, uniqueHash('stop')),
        apply: () => { model.emergency = !model.emergency; }
      };
    default:
      break;
  }
  if (!p) return null;

  switch (kind) {
    case 'subscribe': {
      const remaining = p.supply - p.subscribed;
      const amount = remaining > 0 && rng.chance(0.35) ? remaining : 1 + rng.int(3);
      const next = p.subscribed + amount === p.supply ? S.Funded : S.Subscribed;
      const otherwiseOk = !model.emergency && [S.Open, S.Repriced, S.Subscribed].includes(p.state)
        && p.subscribed + amount <= p.supply;
      return {
        kind, pool: p, args: { amount },
        ok: otherwiseOk && model.ebls[p.e].pledged,
        tag: otherwiseOk && !model.ebls[p.e].pledged ? 'unpledged' : undefined,
        run: () => poolContract.connect(investor).subscribe(p.id, amount),
        apply: () => { p.subscribed += amount; p.state = next; }
      };
    }
    case 'markInTransit':
      return {
        kind, pool: p, ok: !model.emergency && [S.Funded, S.Subscribed].includes(p.state),
        run: () => agent.markInTransit(p.id, uniqueHash('departure')),
        apply: () => { p.state = S.InTransit; }
      };
    case 'agentPause':
      return {
        kind, pool: p, ok: !model.emergency && isActive(p.state),
        run: () => agent.pauseOffering(p.id, uniqueHash('pause')),
        apply: () => { p.before = p.state; p.state = S.Paused; }
      };
    case 'ownerPause':
      return {
        kind, pool: p, ok: isActive(p.state), // human pause works even during a global stop
        run: () => poolContract.emergencyPause(p.id, uniqueHash('manual-pause')),
        apply: () => { p.before = p.state; p.state = S.Paused; }
      };
    case 'resume':
      return {
        kind, pool: p, ok: !model.emergency && p.state === S.Paused,
        run: () => agent.resumeOffering(p.id, uniqueHash('resume')),
        apply: () => { p.state = p.before; }
      };
    case 'pricing': {
      const action = rng.chance(0.08)
        ? 7 + rng.int(4)
        : pickWeighted(rng, [[0, 4], [1, 2], [2, 4], [3, 2], [4, 0.6], [5, 0.4], [6, 3]]);
      const candidates = [0, target + 1, target, p.price, Math.max(0, p.price - 1), p.price + 1, 1 + rng.int(target), 1 + rng.int(target)];
      const price = candidates[rng.int(candidates.length)];
      const riskLevel = rng.chance(0.06) ? 4 : rng.int(4);
      let ok = price > 0 && riskLevel <= 3 && !model.emergency;
      if (ok) {
        if (action === ACTION.RESUME_OFFERING) ok = p.state === S.Paused;
        else if (action === ACTION.PAUSE_OFFERING) ok = isActive(p.state);
        else if (action === ACTION.FREEZE_POOL) ok = isActive(p.state) || p.state === S.Paused;
        else if (action === ACTION.TRIGGER_LIQUIDATION) ok = isActive(p.state) || p.state === S.Paused || p.state === S.Frozen;
        else if (action <= ACTION.REPRICE_DOWN) {
          ok = isActive(p.state) && (price === p.price || (price <= target && (action !== ACTION.REPRICE_DOWN || price < p.price)));
        } else ok = false; // SETTLE / EMERGENCY_PAUSE / CANCEL are not pricing actions
      }
      return {
        kind, pool: p, args: { action, price, riskLevel }, ok,
        run: () => applyPricing(ctx, p.id, price, action, riskLevel),
        apply: () => {
          if (action === ACTION.RESUME_OFFERING) p.state = p.before;
          else if (action === ACTION.PAUSE_OFFERING) { p.before = p.state; p.state = S.Paused; }
          else if (action === ACTION.FREEZE_POOL) p.state = S.Frozen;
          else if (action === ACTION.TRIGGER_LIQUIDATION) p.state = S.Liquidation;
          else {
            p.price = price;

          }
        }
      };
    }
    case 'recordPayment': {
      const amount = rng.chance(0.5) ? Math.max(1, p.subscribed * target) : 1 + rng.int(3);
      return {
        kind, pool: p, args: { amount }, ok: settleable(p) && !p.payment,
        run: () => agent.recordImporterPayment(p.id, uniqueHash('payment'), amount),
        apply: () => { p.payment = amount; }
      };
    }
    case 'correctPayment': {
      const amount = rng.chance(0.5) ? Math.max(1, p.subscribed * target) : 1 + rng.int(3);
      return {
        kind, pool: p, args: { amount }, ok: settleable(p) && p.payment !== null,
        run: () => poolContract.correctImporterPayment(p.id, uniqueHash('corrected-payment'), amount),
        apply: () => { p.payment = amount; }
      };
    }
    case 'recordArrival':
      return {
        kind, pool: p, ok: settleable(p) && !p.arrival,
        run: () => agent.recordCargoArrival(p.id, uniqueHash('arrival')),
        apply: () => { p.arrival = true; }
      };
    case 'settle': {
      const amount = p.payment !== null && rng.chance(0.75) ? p.payment : 1 + rng.int(3);
      return {
        kind, pool: p, args: { amount },
        ok: settleable(p) && p.payment !== null && p.arrival && amount === p.payment && amount >= p.subscribed * target,
        run: () => agent.settle(p.id, amount),
        apply: () => { p.state = S.Repaid; releaseCollateral(p); }
      };
    }
    case 'cancel':
      return {
        kind, pool: p, ok: p.subscribed === 0 && [S.Open, S.Repriced, S.Paused, S.Frozen, S.Liquidation].includes(p.state),
        run: () => poolContract.cancelOffering(p.id, uniqueHash('cancel')),
        apply: () => { p.state = S.Cancelled; releaseCollateral(p); }
      };
    default:
      throw new Error(`unknown operation ${kind}`);
  }
}

async function verifyPool(ctx, model, p, context) {
  const chain = await ctx.pool.offerings(p.id);
  const fail = (what) => `${context}: ${what} on pool #${p.id}`;
  expect(Number(chain.state), fail('state')).to.equal(p.state);
  expect(chain.issuePrice, fail('issuePrice')).to.equal(BigInt(p.price));
  expect(chain.subscribed, fail('subscribed')).to.equal(BigInt(p.subscribed));
  expect(await ctx.token.totalSupply(p.id), fail('token supply')).to.equal(BigInt(p.subscribed));
  expect(chain.paymentProof !== ethers.ZeroHash, fail('payment proof presence')).to.equal(p.payment !== null);
  expect(chain.repaymentAmount, fail('repayment amount')).to.equal(BigInt(p.payment ?? 0));
  expect(chain.arrivalProof !== ethers.ZeroHash, fail('arrival proof presence')).to.equal(p.arrival);

  // Invariants that must hold whatever the sequence was.
  expect(chain.issuePrice <= chain.targetRedemptionValue, fail('issuePrice above target')).to.equal(true);
  expect(chain.subscribed <= chain.tokenSupply, fail('over-subscribed')).to.equal(true);
  if (p.state === S.Repaid) {
    expect(p.subscribed > 0 && p.payment !== null && p.arrival, fail('Repaid without subscribers or proofs')).to.equal(true);
  }
  const slot = await ctx.pool.poolOfEbl(p.e + 1);
  if (isTerminal(p.state)) expect(slot, fail('terminal pool still owns its eBL')).to.not.equal(BigInt(p.id));
  else expect(slot, fail('live pool lost its eBL slot')).to.equal(BigInt(p.id));
}

async function verifyEbl(ctx, model, e, context) {
  const ebl = model.ebls[e];
  const pledgee = await ctx.registry.pledgedTo(e + 1);
  const poolAddress = await ctx.pool.getAddress();
  expect(pledgee, `${context}: pledge of eBL #${e + 1}`).to.equal(ebl.pledged ? poolAddress : ethers.ZeroAddress);
  expect(await ctx.pool.poolOfEbl(e + 1), `${context}: offering slot of eBL #${e + 1}`).to.equal(BigInt(ebl.offeredBy));
}

async function runSequence(seed, steps, visited) {
  const ctx = await deployProtocol();
  const rng = mulberry32(seed);
  const eblCount = 8;
  const model = { emergency: false, pools: [], ebls: [] };
  const poolAddress = await ctx.pool.getAddress();
  for (let e = 0; e < eblCount; e += 1) {
    await send(ctx.registry.mintEBL(ethers.id(`model:${seed}:${e}`), ctx.owner.address));
    await send(ctx.registry.pledge(e + 1, poolAddress));
    model.ebls.push({ pledged: true, offeredBy: 0 });
  }

  for (let step = 1; step <= steps; step += 1) {
    const kind = pickWeighted(rng, OPERATIONS);
    const op = planOperation(kind, ctx, model, rng);
    if (!op) continue;
    const context = `seed ${seed} step ${step} [${describeOperation(op)}]`;
    const succeeded = await attempt(op.run);
    expect(succeeded, `${context}: ${op.ok ? 'the model expects success but the contract reverted' : 'the model expects a revert but the contract accepted it'}`).to.equal(op.ok);
    let touched = op.pool ?? null;
    if (op.ok) {
      const created = op.apply();
      if (created) touched = created;
    }
    visited.operations.add(`${kind}:${op.ok ? 'ok' : `revert${op.tag ? `-${op.tag}` : ''}`}`);
    if (!op.ok && op.tag) visited.operations.add(`${kind}:revert`);
    if (touched) {
      visited.states.add(STATE_NAME[touched.state]);
      await verifyPool(ctx, model, touched, context);
      await verifyEbl(ctx, model, touched.e, context);
    }
    if (step % 25 === 0) {
      for (const pool of model.pools) await verifyPool(ctx, model, pool, `${context} (sweep)`);
      for (let e = 0; e < eblCount; e += 1) await verifyEbl(ctx, model, e, `${context} (sweep)`);
      expect(await ctx.pool.emergencyStopped(), `${context}: emergency flag`).to.equal(model.emergency);
    }
  }
  for (const pool of model.pools) await verifyPool(ctx, model, pool, `seed ${seed} final`);
  for (let e = 0; e < eblCount; e += 1) await verifyEbl(ctx, model, e, `seed ${seed} final`);
}

describe('RWAOfferingPool vs. reference model (randomised)', function () {
  this.timeout(180_000);
  const visited = { states: new Set(), operations: new Set() };

  for (const seed of [11, 22, 33, 44, 55, 66]) {
    it(`agrees with the model on seed ${seed}`, async () => {
      await runSequence(seed, 300, visited);
    });
  }

  it('the random walks actually reached the interesting states and rejections', () => {
    console.log(`      states reached: ${[...visited.states].sort().join(', ')}`);
    for (const state of ['Open', 'Subscribed', 'Funded', 'InTransit', 'Paused', 'Frozen', 'Liquidation', 'Repaid', 'Cancelled']) {
      expect(visited.states.has(state), `state ${state} was never reached`).to.equal(true);
    }
    for (const operation of ['settle:ok', 'settle:revert', 'cancel:ok', 'cancel:revert', 'pricing:ok', 'pricing:revert', 'subscribe:revert', 'createOffering:revert', 'correctPayment:ok', 'registryRelease:revert']) {
      expect(visited.operations.has(operation), `operation ${operation} never happened`).to.equal(true);
    }
  });
});
