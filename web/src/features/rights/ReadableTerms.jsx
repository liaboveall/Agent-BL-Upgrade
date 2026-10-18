const amount = (v) => `${BigInt(v) / 1000000n}.${(BigInt(v) % 1000000n).toString().padStart(6, '0')}`;
const time = (v) => new Date(Number(v) * 1000).toISOString();
export function ReadableTerms({ pack, zh }) {
  const { document: doc, terms: t } = pack;
  const roles = { issuer: ['研究签发方', 'Research issuer'], holder: ['单证持有人', 'Title holder'], operator: ['放款运营方', 'Disbursement operator'],
    valuer: ['研究估值方', 'Research valuer'], compliance: ['资格审查方', 'Eligibility reviewer'], disposer: ['处置提议方', 'Disposal proposer'],
    reviewer: ['处置审核方', 'Resolution reviewer'], governance: ['延时治理', 'Delayed governance'] };
  return <div className="readable-terms">
    <h3>{zh ? '完整融资条款' : 'Complete financing terms'} · v{doc.revision}</h3>
    <p>{zh ? '虚构铜货物' : 'Fictional copper'} · {doc.scenario.origin} → {doc.scenario.destination} · {zh ? '研究签发方 · 测试代币。地址分工不证明独立组织、真实货权或可执行处置权。' : 'research issuer · test assets. Role addresses do not prove independent organizations, real title or enforceable disposal rights.'}</p>
    <dl>{Object.entries(doc.parties).map(([role, value]) => <div key={role}><dt>{roles[role][zh ? 0 : 1]}</dt><dd><code>{value}</code></dd></div>)}
      <div><dt>{zh ? '单证登记编号' : 'Registered title ID'}</dt><dd>{t.eblId}</dd></div>
      <div><dt>{zh ? '单证材料承诺' : 'Title material commitment'}</dt><dd><code>{t.documentHash}</code></dd></div>
      <div><dt>{zh ? '融资收款人' : 'Financing recipient'}</dt><dd><code>{t.exporter}</code></dd></div>
      <div><dt>{zh ? '测试资产 / 小数位' : 'Test asset / decimals'}</dt><dd><code>{t.settlementAsset}</code> · 6 · TEST_USDC</dd></div>
      <div><dt>{zh ? '募集截止（含）' : 'Subscription deadline (inclusive)'}</dt><dd>{time(t.subscribeUntil)}</dd></div>
      <div><dt>{zh ? '放款截止（不含）' : 'Disbursement deadline (exclusive)'}</dt><dd>{time(t.disburseUntil)}</dd></div>
      <div><dt>{zh ? '债务到期' : 'Debt maturity'}</dt><dd>{time(t.maturity)}</dd></div>
      <div><dt>{zh ? '每份实付 / 目标兑付' : 'Paid / target per share'}</dt><dd>{amount(t.issuePrice)} / {amount(t.target)} TEST_USDC</dd></div>
      <div><dt>{zh ? '份额上限 / 最低募集' : 'Share supply / minimum raise'}</dt><dd>{t.supply} / {amount(t.minRaise)} TEST_USDC</dd></div>
      <div><dt>{zh ? '平台费用上限' : 'Platform fee cap'}</dt><dd>0 TEST_USDC</dd></div>
    </dl>
    <p>{zh ? '认购款先托管；每笔放款复核估值、资格和来源。未放款在放款截止可由任何人关闭并退本金；失败募集按实付退款。目标收益不是预期收益，本金与回报均可能损失。结清后仍须自行领取。' : 'Subscriptions enter escrow. Each draw revalidates valuation, eligibility and sources. Anyone can close an undisbursed pool at its draw deadline for principal exit; failed funding refunds actual cost. Target return is not expected return. Principal and returns may be lost. Investors claim separately after settlement.'}</p>
    <p>{zh ? '部分放款：P=实收本金，L=已放款，G=已售份额×目标；目标 T=P+ceil((G−P)×L/P)，待偿=max(T−(P−L+实际回款),0)。闲置本金不计溢价。' : 'Partial draw: P=paid principal, L=drawn cash, G=sold shares × target. Target T=P+ceil((G−P)×L/P); debt=max(T−(P−L+recovery),0). Idle principal earns no premium.'}</p>
    <p>{zh ? '处置通知 1 天，公告后 3 天硬截止。通知窗口内最多一次冻结；换 hash 或参与者不能重开。审核和治理缺席时任何人可在硬截止按现金规则终局；到期未公告也可发起退出。终局后追加材料通过补偿性回款或链外救济处理。' : 'Resolution has one day notice and a three day hard limit. One freeze in the notice window; changing hash or participant cannot restart it. Anyone can finalize cash at the hard limit if review or governance is absent; maturity also permits a public exit. Later evidence uses compensating recovery or external remedies.'}</p>
    <p>{zh ? '累计现金按永久认购槽位逐原子循环分配，领取顺序不改变权益。最多 32 段、1,000,000 份；首次领取烧毁份额后仍保留迟到回款权利。误转不计为池回款，须另行对账。' : 'Cumulative cash is allocated in atomic units to permanent subscription slots, independently of claim order. Up to 32 segments and 1,000,000 shares. Burning shares preserves later recovery rights. Direct transfers require separate reconciliation.'}</p>
    <ul>{doc.sources.map((source) => <li key={source.field}>{source.field}: {source.status} · {source.reference}</li>)}</ul>
    {pack.pool_id != null && <p><a href={`/api/controlled/offerings/${pack.pool_id}/terms?download=1`} download>{zh ? '下载完整条款与复算字段' : 'Download complete terms and verification fields'}</a></p>}
  </div>;
}
