import test from 'node:test';
import assert from 'node:assert/strict';
import { newContext, mergeContext, deltaSchema } from '../src/copilot/context.js';
import { parseIntent, routeIntent, commodityOf } from '../src/copilot/intentRouter.js';

const fresh = () => newContext({ id: 'session', now: 0, ttlSec: 60, mode: 'demo', generation: 1 });
const turn = (context, message) => mergeContext(context, parseIntent(message, context));

test('Copilot: refine, commodity override, negation and reset preserve exactly the intended dimensions', () => {
  let context = turn(fresh(), '铜，新加坡，低风险，预算1万美元');
  context = turn(context, '收益至少8%，期限不超过30天');
  assert.equal(context.constraints.ticket_usd, 10000);
  assert.equal(context.constraints.yield_min_bps, 800);
  assert.equal(context.constraints.tenor_days_max, 30);
  context = turn(context, '算了，换成铝');
  assert.deepEqual(context.constraints.commodities_include, ['aluminium']);
  assert.deepEqual(context.constraints.regions_include, []);
  assert.equal(context.constraints.risk_max, 'LOW');
  assert.equal(context.constraints.ticket_usd, 10000);
  context = turn(context, '不要铝，避开霍尔木兹');
  assert.deepEqual(context.constraints.commodities_include, []);
  assert.deepEqual(context.constraints.commodities_exclude, ['aluminium']);
  assert.deepEqual(context.constraints.chokepoints_avoid, ['hormuz']);
  context = turn(context, '改成铝');
  assert.deepEqual(context.constraints.commodities_exclude, []);
  assert.deepEqual(context.history.at(-1).overrides, ['commodities_include']);
  context = turn(context, '重新开始');
  assert.equal(context.constraints.ticket_usd, undefined);
  assert.deepEqual(context.constraints.commodities_include, []);
  assert.deepEqual(context.soft, {});
});

test('Copilot: refinement tightens limits; an explicit override can relax a single dimension', () => {
  let context = turn(fresh(), '低风险，收益至少8%，期限最多20天，融资规模不超过100万美元，保险覆盖110%');
  context = turn(context, '中风险，收益至少5%，期限最多30天，融资规模不超过200万美元，保险覆盖100%');
  assert.equal(context.constraints.risk_max, 'LOW');
  assert.equal(context.constraints.yield_min_bps, 800);
  assert.equal(context.constraints.tenor_days_max, 20);
  assert.equal(context.constraints.financing_max_usd, 1000000);
  assert.equal(context.constraints.insurance_coverage_min, 1.1);
  context = turn(context, '改成中风险，收益至少5%');
  assert.equal(context.constraints.risk_max, 'MEDIUM');
  assert.equal(context.constraints.yield_min_bps, 500);
  assert.equal(context.constraints.tenor_days_max, 20);
  assert.equal(context.soft.prefer_low_volatility, false);
});

const routes = [
  ['browse investments', 'EXPLORATORY_BROWSE'], ['低风险铜', 'TARGETED_SEARCH'], ['actually aluminium', 'OVERRIDE'],
  ['compare copper and soybeans', 'COMPARE'], ['为什么', 'EXPLAIN'], ['show my portfolio', 'PORTFOLIO'],
  ['subscribe USD 1000', 'ACTION_SUBSCRIBE'], ['buy a report', 'ACTION_BUY_REPORT'], ['start over', 'RESET'],
  ['write code', 'OUT_OF_SCOPE'], ['收益至少100001bps', 'CLARIFY']
];
for (const [message, intent] of routes) test(`Copilot intent: ${message}`, () => assert.equal(parseIntent(message).intent, intent));

test('Copilot: Chinese and English commodities, ports, negative terms, units and payout speeds', () => {
  const parsed = parseIntent('medium risk, copper concentrate, exclude crude, avoid Hormuz, Singapore, return >= 8%, within 12 days, invest USD 20k, insurance 110%, fast payout');
  assert.equal(parsed.constraints_delta.risk_max, 'MEDIUM');
  assert.deepEqual(parsed.constraints_delta.commodities_include, ['copper_concentrate']);
  assert.deepEqual(parsed.constraints_delta.commodities_exclude, ['crude']);
  assert.equal(parsed.constraints_delta.ticket_usd, 20000);
  assert.equal(parsed.constraints_delta.yield_min_bps, 800);
  assert.equal(parsed.constraints_delta.tenor_days_max, 12);
  assert.equal(parsed.constraints_delta.insurance_coverage_min, 1.1);
  assert.equal(parsed.constraints_delta.payout_speed, 'FAST');
  assert.deepEqual(parsed.constraints_delta.regions_include, ['singapore']);
  assert.deepEqual(parsed.constraints_delta.chokepoints_avoid, ['hormuz']);
  assert.equal(commodityOf('Copper Concentrate'), 'copper_concentrate');
  assert.equal(commodityOf('nothing'), 'unknown');
  for (const [message, expected] of [['成品油', 'refined'], ['大豆', 'soybean'], ['橡胶', 'rubber'], ['铁矿石', 'iron_ore'], ['aluminum', 'aluminium']]) {
    assert.deepEqual(parseIntent(message).constraints_delta.commodities_include, [expected]);
  }
  assert.deepEqual(parseIntent('不要上海的铜').constraints_delta.regions_exclude, ['shanghai']);
  assert.equal(parseIntent('收益大概百分之八').ambiguities[0], 'numeric_preference');
});

test('Copilot: LLM prose interpretation is validated and deterministic numeric constraints win', async () => {
  const chatFn = async () => ({ content: JSON.stringify({ intent: 'TARGETED_SEARCH', confidence: 0.9,
    constraints_delta: { yield_min_bps: 9000, ticket_usd: 1000000, commodities_include: ['soybean'], admin: true }, override_dims: [] }) });
  const result = await routeIntent('预算1000美元，收益至少8%，铜', fresh(), { llmConfigured: true, chatFn });
  assert.equal(result.mode, 'llm');
  assert.equal(result.constraints_delta.yield_min_bps, 800);
  assert.equal(result.constraints_delta.ticket_usd, 1000);
  assert.deepEqual(result.constraints_delta.commodities_include, ['copper']);
  assert.equal(result.constraints_delta.admin, undefined);
  const inference = await routeIntent('grain assets', fresh(), { llmConfigured: true, chatFn });
  assert.deepEqual(inference.constraints_delta.commodities_include, ['soybean']);
  assert.equal(inference.constraints_delta.ticket_usd, undefined);
});

test('Copilot: malformed, low-confidence and failing models fall back; a model cannot infer an action or reset', async () => {
  for (const content of ['not JSON', '{"confidence":2,"intent":"REFINE"}', '{"confidence":0.1,"intent":"RESET"}', '{"confidence":0.9,"intent":"ACTION_SUBSCRIBE"}']) {
    const result = await routeIntent('铜', fresh(), { llmConfigured: true, chatFn: async () => ({ content }) });
    assert.equal(result.intent, 'TARGETED_SEARCH');
    assert.deepEqual(result.constraints_delta.commodities_include, ['copper']);
  }
  assert.equal((await routeIntent('low risk', fresh(), { llmConfigured: true, chatFn: async () => { throw new Error('offline'); } })).mode, 'deterministic');
  assert.deepEqual(deltaSchema.parse({}), {}, 'an absent delta must not erase model-inferred or existing arrays');
});

test('Copilot: history is bounded, immutable, and contains structured deltas only', () => {
  const original = fresh();
  let context = original;
  for (let index = 0; index < 40; index += 1) context = turn(context, '低风险');
  assert.equal(original.history.length, 0);
  assert.equal(context.history.length, 32);
  assert.equal(context.history.at(-1).turn, 40);
  assert.ok(!JSON.stringify(context).includes('低风险'));
});

test('softer risk wording reweights the ranking without excluding assets, and a bare 投 sets the ticket', () => {
  const turn = parseIntent('我想投10万美元，风险低一点，收益8%以上，推荐哪几个项目？');
  assert.equal(turn.constraints_delta.ticket_usd, 100000);
  assert.equal(turn.constraints_delta.yield_min_bps, 800);
  assert.equal(turn.constraints_delta.risk_max, undefined, '"a bit lower" is not a hard LOW limit');
  assert.equal(turn.soft_delta.prefer_low_volatility, true);
  for (const text of ['风险小一些的铜', '给我稳一点的', 'something less risky', 'safer options please']) {
    assert.equal(parseIntent(text).soft_delta.prefer_low_volatility, true, text);
  }
  assert.equal(parseIntent('低风险的铜').constraints_delta.risk_max, 'LOW', 'explicit 低风险 stays a hard limit');
  assert.equal(parseIntent('unsafe is fine').soft_delta.prefer_low_volatility, undefined);
});
