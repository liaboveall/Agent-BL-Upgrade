import { useEffect, useState } from 'react';
import { useLang } from '../../state/hooks.js';

export function OperationsPanel() {
  const zh = useLang() === 'zh', [state, setState] = useState(null);
  useEffect(() => {
    const abort = new AbortController();
    const poll = async () => {
      try {
        const response = await fetch('/api/ready', { signal: abort.signal });
        const body = await response.json();
        if (!abort.signal.aborted) setState({ ...body, ok: response.ok && body.ok === true });
      } catch { if (!abort.signal.aborted) setState({ ok: false, status: 'unavailable' }); }
    };
    poll(); const timer = setInterval(poll, 15000);
    return () => { abort.abort(); clearInterval(timer); };
  }, []);
  return <aside className="operations-panel" aria-label={zh ? '服务与资金操作' : 'Service and funding operations'}>
    <details>
      <summary>{zh ? '服务状态与操作恢复' : 'Service status and recovery'}</summary>
      <p role="status">{state?.ok ? (zh ? '运行检查正常。每笔资金操作仍以钱包及链上确认结果为准。' : 'Operating checks are healthy. Funding actions still require wallet and chain confirmation.')
        : state ? (zh ? '运行状态尚未确认；新增操作须等待检查恢复，已有记录可继续核对。' : 'Operational readiness is unconfirmed. New intake awaits recovery; existing records remain available for reconciliation.')
          : (zh ? '正在核对运行状态…' : 'Checking operational readiness…')}</p>
      <dl>
        <div><dt>{zh ? '当前范围' : 'Current scope'}</dt><dd>{zh ? '研究与测试网；使用模拟单证和测试代币。' : 'Research and testnet, using simulated titles and test assets.'}</dd></div>
        <div><dt>{zh ? '资金状态' : 'Funding status'}</dt><dd>{zh ? '认购托管、放款、回收和可领取金额分别记录。结清状态不代表投资者已领取。' : 'Subscription escrow, disbursement, recovery and claimable amounts are separate. Settlement does not mean the investor has claimed.'}</dd></div>
        <div><dt>{zh ? '交易中断' : 'Interrupted transaction'}</dt><dd>{zh ? '保留原交易记录，先核对回执；未确认时不重复付款。' : 'Keep the original transaction record and reconcile its receipt before another payment.'}</dd></div>
        <div><dt>{zh ? '已有退出权' : 'Existing exit rights'}</dt><dd>{zh ? '读取、对账和领取入口保持可用；链上状态决定能否退款或领取。' : 'Read, reconcile and claim routes remain available. Chain state determines refund and claim eligibility.'}</dd></div>
      </dl>
      {state?.revision && state.revision !== 'UNRECORDED' && <p className="muted">{zh ? '运行版本' : 'Running revision'}: <code>{state.revision.slice(0, 12)}</code></p>}
    </details>
  </aside>;
}
