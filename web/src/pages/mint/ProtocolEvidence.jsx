import { useEffect, useState } from 'react';
import { useLang } from '../../state/hooks.js';
import * as f from '../../lib/format.js';
import { protocolDeploymentInfo } from '../../lib/web3.js';
import { Card, CardHead, KV } from '../../components/ui.jsx';

/** Research quote commitments and the separately verified controlled instance. */
export function ProtocolEvidence({ quote }) {
  const zh = useLang() === 'zh';
  const [deployment, setDeployment] = useState(null);
  useEffect(() => {
    let current = true;
    protocolDeploymentInfo().then((value) => { if (current) setDeployment(value); }).catch(() => {});
    return () => { current = false; };
  }, []);
  return <Card aria-labelledby="onchain-h" className="protocol-evidence">
    <CardHead id="onchain-h" title={zh ? '条款承诺与受控实例' : 'Quote commitments and controlled instance'} level={3} />
    <p className="muted small">{zh ? '以下哈希标识本次研究报价。实际发行须通过单证、估值与持有人同意流程。' : 'These hashes identify this research quote. Issuance requires title, valuation and holder consent.'}</p>
    <div className="kv-stack">
      <KV label="quote_hash" mono><span id="quote-hash" title={quote.quote_hash}>{f.shortHash(quote.quote_hash, 14, 8)}</span></KV>
      <KV label="evidence_hash" mono><span id="evidence-hash" title={quote.evidence_hash}>{f.shortHash(quote.evidence_hash, 14, 8)}</span></KV>
    </div>
    <details id="protocol-proof"><summary>{zh ? '受控 v5 测试网配置' : 'Controlled v5 testnet configuration'}</summary>
      <p id="protocol-access-model">{zh ? '仅测试资产；资格与条款同意后方可认购。连接状态由融资面板实时核验。' : 'Test assets only. Eligibility and terms acceptance are required. The financing panel verifies connection status.'}</p>
      <ul className="contract-list" id="protocol-contracts">{Object.entries(deployment?.contracts ?? {}).map(([name, address]) => <li key={name}>
        <span>{name}</span><a href={deployment.explorerBase + '/address/' + address} target="_blank" rel="noopener noreferrer" className="mono">{f.shortHash(address, 8, 6)} ↗</a>
      </li>)}</ul>
    </details>
  </Card>;
}
