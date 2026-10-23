// Plain-language labels for the evidence a figure rests on. The server reports short codes
// (`fixture`, `declared`, ...); people reading the terms should not have to decode them.
const STATUS = {
  fixture: ['演示数据', 'Demo data'], live: ['实时', 'Live'], stale: ['已过期', 'Stale'], unavailable: ['不可用', 'Unavailable'],
  offline: ['离线快照', 'Offline snapshot'], synthetic: ['合成数据', 'Synthetic data'], declared: ['单证申报', 'Declared on the documents'],
  estimated: ['估算', 'Estimated'], reference: ['参考价', 'Reference price'], mixed: ['部分滞后', 'Partly stale']
};
const FIELDS = {
  invoice: ['发票金额', 'Invoice amount'], cost: ['货物成本', 'Cost of goods'], collateral: ['担保估值', 'Collateral estimate'],
  market: ['市场参考', 'Market reference'], risk: ['风险压力', 'Risk pressure']
};

export const sourceStatusLabel = (status, zh) => STATUS[status]?.[zh ? 0 : 1] ?? String(status ?? '—');
export const sourceFieldLabel = (field, zh) => FIELDS[field]?.[zh ? 0 : 1] ?? field;
