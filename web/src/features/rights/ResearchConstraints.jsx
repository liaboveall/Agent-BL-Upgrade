import { useLang } from '../../state/hooks.js';
import { sourceStatusLabel } from '../../lib/source-status.js';
const money = (v) => Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function ResearchConstraints({ quote }) {
  const zh = useLang() === 'zh', r = quote.research_feasibility;
  if (!r) return null;
  const labels = { base: ['基准', 'Base'], low_profit: ['低毛利（25%）', 'Low profit (25%)'], high_funding_cost: ['资金成本 +10pp', 'Funding cost +10pp'], high_loss_pressure: ['损失压力 +20pp', 'Loss buffer +20pp'] };
  const fields = { invoice: ['发票金额', 'Invoice amount'], cost: ['货物成本', 'Cost of goods'], collateral: ['担保估值', 'Collateral estimate'], market: ['市场参考', 'Market reference'], risk: ['风险压力', 'Risk pressure'] };
  const sourceLabels = { declared_invoice_not_independently_verified: ['声明金额，未经独立核验', 'Declared amount without independent verification'],
    declared: ['声明成本', 'Declared cost'], estimated_12pct_margin: ['按12%毛利估算，需核验成本', 'Estimated at 12% margin; verify actual cost'],
    deterministic_rule_estimate_not_realizable_cargo_value: ['规则估算，非货物可兑现价值', 'Rule estimate, not realizable cargo value'],
    deterministic_research_pressure_rules: ['确定性研究压力规则，非违约概率', 'Research pressure rules, not default probability'],
    repository_research_assumption: ['研究假设', 'Research assumption'] };
  return <div className="research-constraints">
    <h3>{zh ? '研究定价可行区间' : 'Research pricing feasibility'}</h3>
    {/* Three bounds the quote must sit between, read as labelled figures rather than a slash-separated line. */}
    <dl className="research-figures">
      <div><dt>{zh ? '资方补偿下限' : 'Investor compensation floor'}</dt><dd>{money(r.investor_floor_usd)} USD</dd></div>
      <div><dt>{zh ? '借款人成本上限' : 'Borrower cost cap'}</dt><dd>{money(r.borrower_ceiling_usd)} USD</dd></div>
      <div><dt>{zh ? '担保约束后上限' : 'Collateral-constrained cap'}</dt><dd>{money(r.total_ceiling_usd)} USD</dd></div>
    </dl>
    <p className="small muted">{zh ? '年化假设' : 'Annual assumptions'}: {zh ? '资金成本' : 'funding'} {r.policy.funding_rate_bps} bps · {zh ? '运营补偿' : 'operations'} {r.policy.operations_rate_bps} bps · {zh ? '损失压力缓冲' : 'loss buffer'} {r.policy.loss_buffer_bps} bps</p>
    <p>{zh ? '以下为研究政策，未经独立商业校准。风险分表示压力而非违约概率；目标年化不表示预期收益。无共同区间时拒绝。模型不设置资金参数；真实 provider 验收未完成。来源缺失、过期或模型失败需人工接管。' : 'Research policy without independent business calibration. Risk scores express pressure, not default probability; target annual return is not expected return. No common interval means rejection. Models cannot set cash parameters. Live provider acceptance is incomplete. Missing or stale sources and model failures require human takeover.'}</p>
    {quote.data_review_required && <p role="status">{zh ? '待人工接管：数据尚未达到来源要求，融资已暂停。' : 'Human takeover pending: data does not meet source requirements; financing is paused.'}</p>}
    <table><caption>{zh ? '敏感性分析（不是概率预测）' : 'Sensitivity analysis (not probability forecasts)'}</caption><thead><tr><th>{zh ? '情景' : 'Scenario'}</th><th>{zh ? '资方下限 USD' : 'Investor floor USD'}</th><th>{zh ? '共同上限 USD' : 'Common cap USD'}</th><th>{zh ? '结论' : 'Outcome'}</th></tr></thead>
      <tbody>{r.sensitivity.map((row) => <tr key={row.scenario}><td>{labels[row.scenario][zh ? 0 : 1]}</td><td>{money(row.investor_floor_usd)}</td><td>{money(row.total_ceiling_usd)}</td><td>{row.feasible ? (zh ? '研究区间可行' : 'Research interval feasible') : (zh ? '拒绝：无共同区间' : 'Reject: no common interval')}</td></tr>)}</tbody></table>
    <ul>{Object.entries(quote.field_sources ?? {}).map(([field, source]) => <li key={field}>{fields[field]?.[zh ? 0 : 1] ?? field}: {sourceStatusLabel(source.status, zh)} · {sourceLabels[source.source]?.[zh ? 0 : 1] ?? source.source}</li>)}</ul>
  </div>;
}
